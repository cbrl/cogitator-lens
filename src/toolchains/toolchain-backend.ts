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
	ArtifactRenderContext,
	RenderedArtifact,
	CompileDiagnostic,
} from '../types/index.js';
import { samePath } from '../toolchain-arguments.js';
import * as exec from '../exec.js';
import { withTemporaryDirectory } from '../temporary-directory.js';
import type { ToolchainDefinition } from './toolchain-map.js';
import { snapshotArtifactInputs, type ArtifactInputMetadata } from '../compilation/artifact-inputs.js';
import type { InstructionType } from '../artifacts/control-flow-graph/parsers/instruction-sets.js';
import type { AssemblyCfgParser } from '../artifacts/control-flow-graph/parsers/assembly-cfg-parser.js';
import { DotNetPdbParser, type DotNetSourceMapping } from '../vendor/lib/parsers/pdb-parser-dotnet.js';

const maxArtifactFileBytes = 50 * 1024 * 1024;

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

/** A successful tool invocation did not create its required artifact file. */
export class MissingToolOutputError extends Error {
	constructor(
		public readonly filename: string,
		options?: ErrorOptions,
	) {
		super(`Toolchain did not produce the expected output file: ${filename}`, options);
		this.name = 'MissingToolOutputError';
	}
}

export interface BinaryDisassembler {
	readonly tool: string;
	readonly arguments: (objectFile: string) => readonly string[];
	readonly normalizeOutput?: (output: string) => string;
}

export interface DotNetIlCompilation {
	readonly compilerArguments: (assemblyFile: string, providerArguments: readonly string[]) => readonly string[];
	readonly disassemblerTool: string;
	readonly disassemblerArguments: (assemblyFile: string) => readonly string[];
}

export interface ToolchainHost {
	log(message: string, level?: 'info' | 'debug'): void;
	parseDiagnostics(output: string, source: Uri, workingDirectory: string): readonly CompileDiagnostic[];
}

export interface ArtifactOutputSpec {
	readonly output:
		| 'stdout'
		| 'stderr'
		| {
				readonly filename: string;
				readonly optional?: boolean;
		  };
	readonly arguments: (
		outputFile: string,
		temporaryDirectory: string,
		providerArguments: readonly string[],
	) => readonly string[];
	/** Invocation-local environment additions, normally paths inside the temporary directory. */
	readonly environment?: (temporaryDirectory: string) => Readonly<Record<string, string>>;
	readonly acceptOutputOnError?: boolean;
}

export interface DependencyCollectionSpec {
	/** Name reserved inside the backend's per-invocation temporary directory. */
	readonly outputFilename: string;
	/** Builds a bounded companion invocation that writes dependency metadata. */
	readonly arguments: (
		outputFile: string,
		temporaryDirectory: string,
		providerArguments: readonly string[],
	) => readonly string[];
	/** Converts the toolchain's dependency format into local input paths. */
	readonly parse: (text: string, workingDirectory: string) => readonly string[];
}

const flagsWithSeparateValues = new Set([
	'-o',
	'-MF',
	'-MT',
	'-MQ',
	'-dumpdir',
	'-foptimization-record-file',
	'/clang:-o',
	'/clang:-foptimization-record-file',
	'/Fo',
	'/Fa',
	'/Fd',
	'/Fi',
	'/sourceDependencies',
]);
const flagsWithJoinedValues = /^(?:-o|-MF|-MT|-MQ|-dumpdir=|\/[Ff][OoAaDdIi]|\/[Ss]ource[Dd]ependencies:).+/;
const artifactOutputFlags =
	/^(?:-emit-llvm|-fdump-tree-cfg(?:-[^=]+)*(?:=.*)?|-save-temps(?:=.*)?|-f(?:no-)?stack-usage|-fsave-optimization-record(?:=.*)?|-foptimization-record-file(?:=.*)?|-fopt-info(?:-[^=]+)?(?:=.*)?|\/clang:-(?:emit-llvm|S|gline-tables-only|save-temps(?:=.*)?|f(?:no-)?stack-usage|fsave-optimization-record(?:=.*)?|foptimization-record-file(?:=.*)?))$/;
const compilerManagedFlags = new Set([
	'-S',
	'-c',
	'-E',
	'-fsyntax-only',
	'-M',
	'-MM',
	'-MD',
	'-MMD',
	'/c',
	'/FA',
	'/FAc',
	'/FAs',
	'/FAcs',
	'/E',
	'/EP',
	'/P',
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
		if (argument === '-Xclang' && args[index + 1] === '-ast-dump') {
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
	readonly providerArguments: readonly string[];
	readonly overriddenNames: readonly string[];
	readonly environmentVariableNames: readonly string[];
	readonly started: number;
}

interface ToolchainRun {
	readonly invocation: PreparedInvocation;
	readonly result: exec.ExecResult;
}

export class ToolchainBackend {
	readonly profile: ToolchainProfile;
	private readonly definition: ToolchainDefinition;
	private readonly host: ToolchainHost;
	private readonly asmParser?: AsmParser;
	// Binary disassembly is always GNU objdump-style text (GNU/LLVM objdump, or dumpbin
	// normalized to that shape by binary-disassembly-producer.ts), regardless of which
	// dialect `asmParser` handles for textual assembly. Parsing it with a dedicated plain
	// `AsmParser` keeps that independent of a backend's assembly dialect (e.g. MSVC's
	// `VcAsmParser`, whose own binary-mode parsing is an unimplemented upstream stub).
	private readonly binaryAsmParser: AsmParser;
	private readonly cfgParser?: AssemblyCfgParser;

	constructor(profile: ToolchainProfile, definition: ToolchainDefinition, host: ToolchainHost) {
		this.profile = profile;
		this.definition = definition;
		this.host = host;
		this.asmParser = definition.createParser?.();
		this.binaryAsmParser = definition.createBinaryParser?.() ?? new AsmParser(noopPropertyGetter);
		this.cfgParser = definition.createCfgParser?.();
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
		return this.produceArtifactWithTransform(
			'assembly',
			source,
			options,
			{
				output: { filename: 'output.asm' },
				arguments: (outputFile, _temporaryDirectory, providerArguments) => [
					...outputArguments('assembly', outputFile, providerArguments),
					...this.outputOptionArguments(options.productionOptions),
				],
			},
			cancellationToken,
			(text, invocation) =>
				this.postProcessAssembly(
					text,
					options.productionOptions,
					invocation.preparedEnvironment,
					invocation.workingDirectory,
					cancellationToken,
				),
		);
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
		return withTemporaryDirectory('coglens-', async (temporaryDirectory) => {
			const objectFile = path.join(temporaryDirectory, objectFilename);
			const { invocation, result: compilerResult } = await this.run(
				source,
				options,
				(providerArguments) => outputArguments('object', objectFile, providerArguments),
				cancellationToken,
			);
			const disassemblerExecutable = this.profile.tools[disassembler.tool];
			if (!disassemblerExecutable) {
				throw new Error(`${this.profile.displayName} has no ${disassembler.tool} auxiliary tool.`);
			}

			const disassemblerArguments = disassembler.arguments(objectFile);
			this.reportInvocation(options, invocation, disassemblerExecutable, disassemblerArguments);
			this.host.log(`Command: ${disassemblerExecutable} ${disassemblerArguments.join(' ')}`);
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
			const inputMetadata = await this.collectDependencyInputs(
				source,
				invocation,
				temporaryDirectory,
				cancellationToken,
			);
			return this.buildRawArtifact(
				'binary-disassembly',
				text,
				[compilerResult.stderr, compilerResult.stdout, disassemblerResult.stderr].join('\n'),
				source,
				invocation,
				inputMetadata,
				disassemblerExecutable,
				disassemblerArguments,
			);
		});
	}

	async produceDotNetIl(
		source: Uri,
		options: CompileOptions,
		compilation: DotNetIlCompilation,
		cancellationToken: CancellationToken,
	): Promise<RawArtifact> {
		return withTemporaryDirectory('coglens-', async (temporaryDirectory) => {
			const assemblyFile = path.join(temporaryDirectory, 'output.dll');
			const pdbFile = path.join(temporaryDirectory, 'output.pdb');
			const { invocation, result: compilerResult } = await this.run(
				source,
				options,
				(providerArguments) => compilation.compilerArguments(assemblyFile, providerArguments),
				cancellationToken,
			);
			let sourceMapping: DotNetSourceMapping | undefined;
			try {
				const [assembly, pdb] = await Promise.all([
					readBoundedArtifactBuffer(assemblyFile),
					readBoundedArtifactBuffer(pdbFile),
				]);
				sourceMapping = new DotNetPdbParser(assembly, pdb).parse();
			} catch (error) {
				this.host.log(
					`Portable PDB source mapping was unavailable: ${error instanceof Error ? error.message : String(error)}`,
					'debug',
				);
			}
			const disassemblerExecutable = this.profile.tools[compilation.disassemblerTool];
			if (!disassemblerExecutable) {
				throw new Error(`${this.profile.displayName} has no ${compilation.disassemblerTool} auxiliary tool.`);
			}

			const disassemblerArguments = compilation.disassemblerArguments(assemblyFile);
			this.reportInvocation(options, invocation, disassemblerExecutable, disassemblerArguments);
			this.host.log(`Command: ${disassemblerExecutable} ${disassemblerArguments.join(' ')}`);
			const disassemblerResult = await exec.execute(disassemblerExecutable, disassemblerArguments, {
				cwd: invocation.workingDirectory,
				env: invocation.preparedEnvironment,
				cancellationToken,
			});
			if (disassemblerResult.returnCode !== 0) {
				throw new ToolExitError(
					`.NET IL disassembler exited with code ${disassemblerResult.returnCode}`,
					disassemblerResult.returnCode,
					disassemblerResult.stdout,
					disassemblerResult.stderr,
				);
			}

			const inputMetadata = await this.collectDependencyInputs(
				source,
				invocation,
				temporaryDirectory,
				cancellationToken,
			);
			const artifact = this.buildRawArtifact(
				'assembly',
				disassemblerResult.stdout,
				[compilerResult.stderr, compilerResult.stdout, disassemblerResult.stderr].join('\n'),
				source,
				invocation,
				inputMetadata,
				disassemblerExecutable,
				disassemblerArguments,
			);
			return {
				...artifact,
				...(sourceMapping ? { dotnetSourceMapping: sourceMapping } : {}),
			};
		});
	}

	async produceArtifact(
		kind: ArtifactKind,
		source: Uri,
		options: CompileOptions,
		spec: ArtifactOutputSpec,
		cancellationToken: CancellationToken,
	): Promise<RawArtifact> {
		return this.produceArtifactWithTransform(kind, source, options, spec, cancellationToken, (text) => text);
	}

	private async produceArtifactWithTransform(
		kind: ArtifactKind,
		source: Uri,
		options: CompileOptions,
		spec: ArtifactOutputSpec,
		cancellationToken: CancellationToken,
		transform: (text: string, invocation: PreparedInvocation) => Promise<string> | string,
	): Promise<RawArtifact> {
		return withTemporaryDirectory('coglens-', async (temporaryDirectory) => {
			const outputFile =
				spec.output === 'stdout' || spec.output === 'stderr'
					? ''
					: path.join(temporaryDirectory, spec.output.filename);
			const { invocation, result } = await this.run(
				source,
				options,
				(providerArguments) => spec.arguments(outputFile, temporaryDirectory, providerArguments),
				cancellationToken,
				spec.acceptOutputOnError,
				spec.environment?.(temporaryDirectory),
			);
			const rawText =
				spec.output === 'stdout'
					? result.stdout
					: spec.output === 'stderr'
						? result.stderr
						: await readBoundedArtifactFile(outputFile, spec.output.optional);
			const text = await transform(rawText, invocation);
			const inputMetadata = await this.collectDependencyInputs(
				source,
				invocation,
				temporaryDirectory,
				cancellationToken,
			);
			const diagnosticOutput =
				spec.output === 'stdout'
					? result.stderr
					: spec.output === 'stderr'
						? result.stdout
						: `${result.stderr}\n${result.stdout}`;
			return this.buildRawArtifact(kind, text, diagnosticOutput, source, invocation, inputMetadata);
		});
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

	classifyAssemblyInstruction(instruction: string): InstructionType | undefined {
		return this.cfgParser?.classifyInstruction(instruction);
	}

	renderArtifact(raw: RawArtifact, options: DisplayOptions, context: ArtifactRenderContext): RenderedArtifact {
		const renderer = this.getArtifactRenderer(raw.kind);
		if (!renderer) {
			throw new Error(`${this.profile.displayName} has no ${raw.kind} rendering capability.`);
		}
		return renderer(raw, options, context);
	}

	getArtifactRenderer(
		kind: ArtifactKind,
	): ((raw: RawArtifact, options: DisplayOptions, context: ArtifactRenderContext) => RenderedArtifact) | undefined {
		const cell = this.definition.artifacts[kind];
		return cell.status === 'available' && cell.outputs === undefined ? cell.renderer : undefined;
	}

	private async run(
		source: Uri,
		options: CompileOptions,
		ownedArguments: (providerArguments: readonly string[]) => readonly string[],
		cancellationToken: CancellationToken,
		acceptOutputOnError = false,
		invocationEnvironment: Readonly<Record<string, string>> = {},
	): Promise<ToolchainRun> {
		const invocation = await this.prepareInvocation(
			source,
			options,
			ownedArguments,
			cancellationToken,
			invocationEnvironment,
		);
		this.host.log(`Producing an artifact for ${source.fsPath} with ${this.profile.displayName}`);
		this.host.log(`Command: ${this.profile.executable} ${invocation.argumentsList.join(' ')}`);
		this.host.log(`Environment overrides: ${invocation.overriddenNames.join(', ') || '(none)'}`, 'debug');

		const result = await exec.execute(this.profile.executable, invocation.argumentsList, {
			cwd: invocation.workingDirectory,
			env: invocation.preparedEnvironment,
			cancellationToken,
		});
		if (result.returnCode !== 0 && !(acceptOutputOnError && result.stdout)) {
			throw new ToolExitError(
				`Toolchain exited with code ${result.returnCode}`,
				result.returnCode,
				result.stdout,
				result.stderr,
			);
		}
		return { invocation, result };
	}

	private buildRawArtifact(
		kind: ArtifactKind,
		text: string,
		diagnosticOutput: string,
		source: Uri,
		invocation: PreparedInvocation,
		inputMetadata: ArtifactInputMetadata,
		executable = this.profile.executable,
		args: readonly string[] = invocation.argumentsList,
	): RawArtifact {
		return {
			kind,
			text,
			diagnostics: this.host.parseDiagnostics(diagnosticOutput, source, invocation.workingDirectory),
			durationMs: performance.now() - invocation.started,
			generatedAt: Date.now(),
			truncated: false,
			...inputMetadata,
			command: {
				executable,
				arguments: args,
				environmentVariableNames: invocation.environmentVariableNames,
				workingDirectory: invocation.workingDirectory,
			},
		};
	}

	private async prepareInvocation(
		source: Uri,
		options: CompileOptions,
		ownedArguments: (providerArguments: readonly string[]) => readonly string[],
		cancellationToken: CancellationToken,
		invocationEnvironment: Readonly<Record<string, string>> = {},
	): Promise<PreparedInvocation> {
		const workingDirectory = options.workingDirectory ?? path.dirname(source.fsPath);
		const environment = {
			...process.env,
			...this.profile.environment,
			...options.env,
			...invocationEnvironment,
		};
		const preparedEnvironment = this.definition.prepareEnvironment
			? await this.definition.prepareEnvironment(this.profile, environment, cancellationToken)
			: environment;

		const strip = this.definition.stripOwnedArguments ?? stripCompilerManagedArguments;
		const providerArguments = strip(
			[...this.profile.defaultArguments, ...(options.args ?? [])],
			source.fsPath,
			workingDirectory,
		);

		const compilerArguments = ownedArguments(providerArguments);
		const argumentsList =
			this.definition.ownedArgumentPlacement === 'before-provider'
				? [...compilerArguments, ...providerArguments, source.fsPath]
				: this.definition.ownedArgumentPlacement === 'command-before-provider'
					? [
							...compilerArguments.slice(0, 1),
							...providerArguments,
							...compilerArguments.slice(1),
							source.fsPath,
						]
					: [...providerArguments, ...compilerArguments, source.fsPath];

		const invocation = {
			workingDirectory,
			preparedEnvironment,
			argumentsList,
			providerArguments,
			overriddenNames: Object.keys({
				...this.profile.environment,
				...options.env,
				...invocationEnvironment,
			}).sort(),
			environmentVariableNames: Object.keys(preparedEnvironment).sort(),
			started: performance.now(),
		};
		this.reportInvocation(options, invocation);
		return invocation;
	}

	private reportInvocation(
		options: CompileOptions,
		invocation: PreparedInvocation,
		executable = this.profile.executable,
		args: readonly string[] = invocation.argumentsList,
	): void {
		options.onInvocation?.(
			Object.freeze({
				executable,
				args: Object.freeze([...args]),
				cwd: invocation.workingDirectory,
				environmentVariableNames: Object.freeze([...invocation.environmentVariableNames]),
			}),
		);
	}

	private async collectDependencyInputs(
		source: Uri,
		invocation: PreparedInvocation,
		temporaryDirectory: string,
		cancellationToken: CancellationToken,
	): Promise<ArtifactInputMetadata> {
		const spec = this.definition.dependencyCollection;
		if (!spec) {
			return snapshotArtifactInputs(source.fsPath, [], 'source-only', invocation.workingDirectory);
		}
		const dependencyFile = path.join(temporaryDirectory, spec.outputFilename);
		const dependencyArguments = spec.arguments(dependencyFile, temporaryDirectory, invocation.providerArguments);

		try {
			const result = await exec.execute(
				this.profile.executable,
				[...invocation.providerArguments, ...dependencyArguments, source.fsPath],
				{
					cwd: invocation.workingDirectory,
					env: invocation.preparedEnvironment,
					cancellationToken,
				},
			);
			if (result.returnCode !== 0) {
				return snapshotArtifactInputs(source.fsPath, [], 'source-only', invocation.workingDirectory);
			}
			const dependencyText = await readBoundedArtifactFile(dependencyFile);
			const dependencies = spec.parse(dependencyText, invocation.workingDirectory);
			if (dependencies.length === 0) {
				return snapshotArtifactInputs(source.fsPath, [], 'source-only', invocation.workingDirectory);
			}
			return snapshotArtifactInputs(source.fsPath, dependencies, 'complete', invocation.workingDirectory);
		} catch (error) {
			if (
				cancellationToken.isCancellationRequested ||
				(error instanceof exec.ExecError && (error.kind === 'cancelled' || error.kind === 'timeout'))
			) {
				throw error;
			}
			return snapshotArtifactInputs(source.fsPath, [], 'source-only', invocation.workingDirectory);
		}
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

async function readBoundedArtifactFile(filename: string, optional = false): Promise<string> {
	let handle: fs.promises.FileHandle;
	try {
		handle = await fs.promises.open(filename, 'r');
	} catch (error) {
		if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') {
			return '';
		}
		throw new MissingToolOutputError(filename, {
			cause: error,
		});
	}
	try {
		const stat = await handle.stat();
		if (stat.size > maxArtifactFileBytes) {
			throw artifactFileLimitError();
		}
		const chunks: Buffer[] = [];
		let position = 0;
		while (position <= maxArtifactFileBytes) {
			const remaining = maxArtifactFileBytes + 1 - position;
			const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
			if (bytesRead === 0) {
				break;
			}
			position += bytesRead;
			if (position > maxArtifactFileBytes) {
				throw artifactFileLimitError();
			}
			chunks.push(buffer.subarray(0, bytesRead));
		}
		return Buffer.concat(chunks, position).toString('utf8');
	} finally {
		await handle.close();
	}
}

async function readBoundedArtifactBuffer(filename: string): Promise<Buffer> {
	const stat = await fs.promises.stat(filename);
	if (stat.size > maxArtifactFileBytes) {
		throw artifactFileLimitError();
	}
	return fs.promises.readFile(filename);
}

function artifactFileLimitError(): exec.ExecError {
	return new exec.ExecError('output-limit', `Toolchain output file exceeded the ${maxArtifactFileBytes}-byte limit`);
}
