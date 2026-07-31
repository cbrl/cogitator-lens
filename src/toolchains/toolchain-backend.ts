import fs from 'fs';
import path from 'path';
import type { CancellationToken, Uri } from 'vscode';
import { AsmParser } from '../vendor/lib/parsers/asm-parser.js';
import { noopPropertyGetter } from '../vendor/compiler-props.js';
import type { ParseFiltersAndOutputOptions } from '../vendor/types/features/filters.interfaces.js';
import type { ParsedAsmResult } from '../vendor/types/asmresult/asmresult.interfaces.js';
import type {
	ArtifactKind,
	ToolchainProfile,
	CompileOptions,
	DisplayOptions,
	ProductionOptions,
	RawArtifact,
} from '../types/index.js';
import { samePath } from '../toolchain-arguments.js';
import * as exec from '../exec.js';
import { withTemporaryDirectory } from '../temporary-directory.js';
import type { ToolchainDefinition } from './toolchain-map.js';

export class ToolExitError extends Error {
	constructor(
		message: string,
		public readonly returnCode: number,
		public readonly stdout: string,
		public readonly stderr: string,
	) {
		super(message);
		this.name = 'ToolExitError';
	}
}

export interface BinaryDisassembler {
	readonly tool: string;
	readonly arguments: (objectFile: string) => readonly string[];
	readonly normalizeOutput?: (output: string) => string;
}

export interface CompilerOutputSpec {
	readonly outputFilename: string;
	readonly optionalOutput?: boolean;
	readonly arguments: (
		outputFile: string,
		temporaryDirectory: string,
		providerArguments: readonly string[],
	) => readonly string[];
}

const flagsWithSeparateValues = new Set([
	'-o',
	'-MF',
	'-MT',
	'-MQ',
	'-foptimization-record-file',
	'/clang:-o',
	'/clang:-foptimization-record-file',
	'/Fo',
	'/Fa',
	'/Fd',
]);
const flagsWithJoinedValues = /^(?:-o|-MF|-MT|-MQ|\/Fo|\/Fa|\/Fd).+/;
const artifactOutputFlags = /^(?:-emit-llvm|-fsave-optimization-record(?:=.*)?|-foptimization-record-file(?:=.*)?|-fopt-info(?:-[^=]+)?(?:=.*)?|\/clang:-(?:emit-llvm|S|gline-tables-only|fsave-optimization-record(?:=.*)?|foptimization-record-file(?:=.*)?))$/;
const compilerManagedFlags = new Set([
	'-S',
	'-c',
	'-M',
	'-MM',
	'-MD',
	'-MMD',
	'/c',
	'/FA',
	'/FAc',
	'/FAs',
	'/FAcs',
]);

/**
 * Strips the output-file and compile-mode flags this extension supplies itself
 * (via `ToolchainDefinition.outputArguments`), so a toolchain's own default
 * arguments can't conflict with them.
 */
export function stripCompilerManagedArguments(
	args: readonly string[],
	sourceFile: string,
	workingDirectory?: string,
): string[] {
	const result: string[] = [];
	for (let index = 0; index < args.length; index++) {
		const argument = args[index];
		if (samePath(argument, sourceFile, workingDirectory) || compilerManagedFlags.has(argument)) {
			continue;
		}
		if (flagsWithSeparateValues.has(argument)) {
			index++;
			continue;
		}
		if (flagsWithJoinedValues.test(argument)) {
			continue;
		}
		if (artifactOutputFlags.test(argument)) {
			continue;
		}
		result.push(argument);
	}
	return result;
}

/**
 * Whether Intel-syntax output arguments should be added, extracted as a pure
 * function so the gating logic (as opposed to full compilation) is directly
 * unit-testable without spawning a compiler.
 */
export function intelOutputArguments(
	definition: Pick<ToolchainDefinition, 'intelSyntax' | 'intelArguments'>,
	options: ProductionOptions,
): readonly string[] {
	return options.intel && definition.intelSyntax === 'selectable' && definition.intelArguments
		? definition.intelArguments
		: [];
}

export async function demangleViaStdin(
	rawAssembly: string,
	demanglerTool: string,
	environment: NodeJS.ProcessEnv,
	workingDirectory: string,
	cancellationToken: CancellationToken,
): Promise<string> {
	const result = await exec.execute(demanglerTool, [], {
		cwd: workingDirectory,
		env: environment,
		cancellationToken,
		stdin: rawAssembly,
	});
	if (result.returnCode !== 0) {
		throw new ToolExitError(
			`Demangler exited with code ${result.returnCode}`,
			result.returnCode,
			result.stdout,
			result.stderr,
		);
	}
	return result.stdout;
}

interface PreparedInvocation {
	readonly workingDirectory: string;
	readonly preparedEnvironment: NodeJS.ProcessEnv;
	readonly argumentsList: readonly string[];
	readonly overriddenNames: readonly string[];
	readonly started: number;
}

export class ToolchainBackend {
	readonly profile: ToolchainProfile;
	private readonly definition: ToolchainDefinition;
	private readonly asmParser?: AsmParser;
	// Binary disassembly is always GNU objdump-style text (GNU/LLVM objdump, or dumpbin
	// normalized to that shape by binary-disassembly-producer.ts), regardless of which
	// dialect `asmParser` handles for textual assembly. Parsing it with a dedicated plain
	// `AsmParser` keeps that independent of a backend's assembly dialect (e.g. MSVC's
	// `VcAsmParser`, whose own binary-mode parsing is an unimplemented upstream stub).
	private readonly binaryAsmParser: AsmParser = new AsmParser(noopPropertyGetter);

	constructor(profile: ToolchainProfile, definition: ToolchainDefinition) {
		this.profile = profile;
		this.definition = definition;
		this.asmParser = definition.createParser?.();
	}

	async produceAssembly(
		source: Uri,
		options: CompileOptions,
		cancellationToken: CancellationToken,
	): Promise<RawArtifact> {
		if (!this.definition.outputArguments || !this.asmParser) {
			throw new Error(`${this.profile.displayName} has no assembly production capability.`);
		}
		const outputArguments = this.definition.outputArguments;
		return withTemporaryDirectory('coglens-', async temporaryDirectory => {
			const outputFile = path.join(temporaryDirectory, 'output.asm');
			const invocation = await this.prepareInvocation(
				source,
				options,
				providerArguments => [
					...this.outputOptionArguments(options.productionOptions),
					...outputArguments('assembly', outputFile, providerArguments),
				],
				cancellationToken,
			);

			const { logChannel } = await import('../logger.js');
			logChannel.info(`Compiling ${source.fsPath} with ${this.profile.displayName}`);
			logChannel.info(`Command: ${this.profile.executable} ${invocation.argumentsList.join(' ')}`);
			logChannel.debug(`Environment overrides: ${invocation.overriddenNames.join(', ') || '(none)'}`);

			const result = await exec.execute(this.profile.executable, invocation.argumentsList, {
				cwd: invocation.workingDirectory,
				env: invocation.preparedEnvironment,
				cancellationToken,
			});
			if (result.returnCode !== 0) {
				throw new ToolExitError(
					`Toolchain exited with code ${result.returnCode}`,
					result.returnCode,
					result.stdout,
					result.stderr,
				);
			}

			const assembly = await fs.promises.readFile(outputFile, 'utf8');
			const text = await this.postProcessAssembly(
				assembly,
				options.productionOptions,
				invocation.preparedEnvironment,
				invocation.workingDirectory,
				cancellationToken,
			);
			const { parseToolDiagnostics } = await import('../diagnostics.js');
			return {
				kind: 'assembly',
				text,
				diagnostics: parseToolDiagnostics(
					`${result.stderr}\n${result.stdout}`,
					source,
					invocation.workingDirectory,
				),
				durationMs: performance.now() - invocation.started,
				truncated: false,
				command: {
					executable: this.profile.executable,
					arguments: invocation.argumentsList,
					environmentVariableNames: invocation.overriddenNames,
					workingDirectory: invocation.workingDirectory,
				},
			};
		});
	}

	async produceBinaryDisassembly(
		source: Uri,
		options: CompileOptions,
		disassembler: BinaryDisassembler,
		cancellationToken: CancellationToken,
	): Promise<RawArtifact> {
		if (!this.definition.outputArguments || !this.definition.objectFilename) {
			throw new Error(`${this.profile.displayName} has no object-file production capability.`);
		}
		const outputArguments = this.definition.outputArguments;
		const objectFilename = this.definition.objectFilename;
		return withTemporaryDirectory('coglens-', async temporaryDirectory => {
			const objectFile = path.join(temporaryDirectory, objectFilename);
			const invocation = await this.prepareInvocation(
				source,
				options,
				providerArguments =>
					outputArguments('object', objectFile, providerArguments),
				cancellationToken,
			);
			const disassemblerExecutable = this.profile.tools[disassembler.tool];
			if (!disassemblerExecutable) {
				throw new Error(`${this.profile.displayName} has no ${disassembler.tool} auxiliary tool.`);
			}

			const { logChannel } = await import('../logger.js');
			logChannel.info(`Compiling ${source.fsPath} to an object file with ${this.profile.displayName}`);
			logChannel.info(`Command: ${this.profile.executable} ${invocation.argumentsList.join(' ')}`);
			logChannel.debug(`Environment overrides: ${invocation.overriddenNames.join(', ') || '(none)'}`);

			const compilerResult = await exec.execute(this.profile.executable, invocation.argumentsList, {
				cwd: invocation.workingDirectory,
				env: invocation.preparedEnvironment,
				cancellationToken,
			});
			if (compilerResult.returnCode !== 0) {
				throw new ToolExitError(
					`Toolchain exited with code ${compilerResult.returnCode}`,
					compilerResult.returnCode,
					compilerResult.stdout,
					compilerResult.stderr,
				);
			}

			const disassemblerArguments = disassembler.arguments(objectFile);
			logChannel.info(`Command: ${disassemblerExecutable} ${disassemblerArguments.join(' ')}`);
			const disassemblerResult = await exec.execute(disassemblerExecutable, disassemblerArguments, {
				cwd: invocation.workingDirectory,
				env: invocation.preparedEnvironment,
				cancellationToken,
			});
			if (disassemblerResult.returnCode !== 0) {
				throw new ToolExitError(
					`Disassembler exited with code ${disassemblerResult.returnCode}`,
					disassemblerResult.returnCode,
					disassemblerResult.stdout,
					disassemblerResult.stderr,
				);
			}

			const text = disassembler.normalizeOutput
				? disassembler.normalizeOutput(disassemblerResult.stdout)
				: disassemblerResult.stdout;
			const { parseToolDiagnostics } = await import('../diagnostics.js');
			return {
				kind: 'binary-disassembly',
				text,
				diagnostics: parseToolDiagnostics(
					[compilerResult.stderr, compilerResult.stdout, disassemblerResult.stderr].join('\n'),
					source,
					invocation.workingDirectory,
				),
				durationMs: performance.now() - invocation.started,
				truncated: false,
				command: {
					executable: disassemblerExecutable,
					arguments: disassemblerArguments,
					environmentVariableNames: invocation.overriddenNames,
					workingDirectory: invocation.workingDirectory,
				},
			};
		});
	}

	async produceCompilerOutput(
		kind: ArtifactKind,
		source: Uri,
		options: CompileOptions,
		spec: CompilerOutputSpec,
		cancellationToken: CancellationToken,
	): Promise<RawArtifact> {
		return withTemporaryDirectory('coglens-', async temporaryDirectory => {
			const outputFile = path.join(temporaryDirectory, spec.outputFilename);
			const invocation = await this.prepareInvocation(
				source,
				options,
				providerArguments => spec.arguments(
					outputFile,
					temporaryDirectory,
					providerArguments,
				),
				cancellationToken,
			);

			const { logChannel } = await import('../logger.js');
			logChannel.info(`Producing ${kind} for ${source.fsPath} with ${this.profile.displayName}`);
			logChannel.info(`Command: ${this.profile.executable} ${invocation.argumentsList.join(' ')}`);
			logChannel.debug(`Environment overrides: ${invocation.overriddenNames.join(', ') || '(none)'}`);

			const result = await exec.execute(this.profile.executable, invocation.argumentsList, {
				cwd: invocation.workingDirectory,
				env: invocation.preparedEnvironment,
				cancellationToken,
			});
			if (result.returnCode !== 0) {
				throw new ToolExitError(
					`Toolchain exited with code ${result.returnCode}`,
					result.returnCode,
					result.stdout,
					result.stderr,
				);
			}

			let text: string;
			try {
				text = await fs.promises.readFile(outputFile, 'utf8');
			} catch (error) {
				if (!spec.optionalOutput || (error as NodeJS.ErrnoException).code !== 'ENOENT') {
					throw error;
				}
				text = '';
			}
			const { parseToolDiagnostics } = await import('../diagnostics.js');
			return {
				kind,
				text,
				diagnostics: parseToolDiagnostics(
					`${result.stderr}\n${result.stdout}`,
					source,
					invocation.workingDirectory,
				),
				durationMs: performance.now() - invocation.started,
				truncated: false,
				command: {
					executable: this.profile.executable,
					arguments: invocation.argumentsList,
					environmentVariableNames: invocation.overriddenNames,
					workingDirectory: invocation.workingDirectory,
				},
			};
		});
	}

	async produceStdoutArtifact(
		kind: ArtifactKind,
		source: Uri,
		options: CompileOptions,
		ownedArguments: readonly string[],
		cancellationToken: CancellationToken,
	): Promise<RawArtifact> {
		const invocation = await this.prepareInvocation(
			source,
			options,
			() => ownedArguments,
			cancellationToken,
		);

		const { logChannel } = await import('../logger.js');
		logChannel.info(`Producing ${kind} for ${source.fsPath} with ${this.profile.displayName}`);
		logChannel.info(`Command: ${this.profile.executable} ${invocation.argumentsList.join(' ')}`);
		logChannel.debug(`Environment overrides: ${invocation.overriddenNames.join(', ') || '(none)'}`);

		const result = await exec.execute(this.profile.executable, invocation.argumentsList, {
			cwd: invocation.workingDirectory,
			env: invocation.preparedEnvironment,
			cancellationToken,
		});
		if (result.returnCode !== 0) {
			throw new ToolExitError(
				`Toolchain exited with code ${result.returnCode}`,
				result.returnCode,
				result.stdout,
				result.stderr,
			);
		}

		const { parseToolDiagnostics } = await import('../diagnostics.js');
		return {
			kind,
			text: result.stdout,
			diagnostics: parseToolDiagnostics(
				result.stderr,
				source,
				invocation.workingDirectory,
			),
			durationMs: performance.now() - invocation.started,
			truncated: false,
			command: {
				executable: this.profile.executable,
				arguments: invocation.argumentsList,
				environmentVariableNames: invocation.overriddenNames,
				workingDirectory: invocation.workingDirectory,
			},
		};
	}

	parseAssembly(rawAssembly: string, options: DisplayOptions): ParsedAsmResult {
		if (!this.asmParser) {
			throw new Error(`${this.profile.displayName} has no assembly parser.`);
		}
		const filters: ParseFiltersAndOutputOptions = { ...options };
		return this.asmParser.process(rawAssembly, filters);
	}

	parseBinaryDisassembly(rawDisassembly: string, options: DisplayOptions): ParsedAsmResult {
		const filters: ParseFiltersAndOutputOptions = { ...options, binary: true };
		return this.binaryAsmParser.process(rawDisassembly, filters);
	}

	private async prepareInvocation(
		source: Uri,
		options: CompileOptions,
		ownedArguments: (providerArguments: readonly string[]) => readonly string[],
		cancellationToken: CancellationToken,
	): Promise<PreparedInvocation> {
		const workingDirectory = options.workingDirectory ?? path.dirname(source.fsPath);
		const environment = {
			...process.env,
			...this.profile.environment,
			...options.env,
		};
		const preparedEnvironment = this.definition.prepareEnvironment
			? await this.definition.prepareEnvironment(this.profile, environment, cancellationToken)
			: environment;

		const strip = this.definition.stripOwnedArguments ?? stripCompilerManagedArguments;
		const providerArguments = strip([
			...this.profile.defaultArguments,
			...(options.args ?? []),
		], source.fsPath, workingDirectory);

		const argumentsList = [
			...providerArguments,
			...ownedArguments(providerArguments),
			source.fsPath,
		];

		return {
			workingDirectory,
			preparedEnvironment,
			argumentsList,
			overriddenNames: Object.keys({ ...this.profile.environment, ...options.env }).sort(),
			started: performance.now(),
		};
	}

	private outputOptionArguments(options: ProductionOptions): readonly string[] {
		return intelOutputArguments(this.definition, options);
	}

	private async postProcessAssembly(
		rawAssembly: string,
		options: ProductionOptions,
		environment: NodeJS.ProcessEnv,
		workingDirectory: string,
		cancellationToken: CancellationToken,
	): Promise<string> {
		if (!options.demangle || !this.profile.tools.demangler) {
			return rawAssembly;
		}
		const demangle = this.definition.demangle ?? demangleViaStdin;
		return demangle(rawAssembly, this.profile.tools.demangler, environment, workingDirectory, cancellationToken);
	}
}
