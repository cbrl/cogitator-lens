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
	AuxiliaryTool,
} from '../types/index.js';
import * as exec from '../exec.js';
import { withTemporaryDirectory } from '../temporary-directory.js';
import type { ToolchainDefinition } from './toolchain-contracts.js';
import { snapshotArtifactInputs, type ArtifactInputMetadata } from '../compilation/artifact-inputs.js';
import type { InstructionType } from '../artifacts/control-flow-graph/parsers/instruction-sets.js';
import type { AssemblyCfgParser } from '../artifacts/control-flow-graph/parsers/assembly-cfg-parser.js';
import type { AssemblyLine } from '../artifacts/control-flow-graph/parsers/assembly-line.js';
import type { GraphParseResult } from '../artifacts/control-flow-graph/control-flow-graph-model.js';

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

export interface SecondaryToolSpec {
	/** Logical workspace-file names mapped to filenames reserved in the temporary directory. */
	readonly workspaceFiles: Readonly<Record<string, string>>;
	readonly compilerArguments: (
		files: Readonly<Record<string, string>>,
		providerArguments: readonly string[],
	) => readonly string[];
	/** Profile key of the auxiliary tool that consumes the compiler output. */
	readonly tool: string;
	readonly toolArguments: (files: Readonly<Record<string, string>>) => readonly string[];
	readonly normalizeOutput?: (output: string) => string;
	/** Runs after the compiler, before the tool; its result becomes RawArtifact.producerData. */
	readonly producerData?: (files: Readonly<Record<string, string>>) => Promise<unknown>;
}

export interface ToolchainHost {
	log(message: string, level?: 'info' | 'debug'): void;
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

/** Runs a text-transforming auxiliary tool using its declared input transport. */
export async function executeTextTool(
	input: string,
	tool: AuxiliaryTool,
	environment: NodeJS.ProcessEnv,
	workingDirectory: string,
	cancellationToken: CancellationToken,
): Promise<string> {
	switch (tool.inputMode) {
		case 'file-argument':
			return withTemporaryDirectory('coglens-tool-', async (temporaryDirectory) => {
				const inputFile = path.join(temporaryDirectory, 'input.txt');
				await fs.promises.writeFile(inputFile, input, 'utf8');
				return executeTextToolInvocation(
					tool.executable,
					[inputFile],
					undefined,
					environment,
					workingDirectory,
					cancellationToken,
				);
			});
		case 'stdin':
			return executeTextToolInvocation(tool.executable, [], input, environment, workingDirectory, cancellationToken);
		default:
			throw new Error(`Unsupported auxiliary-tool input mode: ${String(tool.inputMode)}`);
	}
}

async function executeTextToolInvocation(
	executable: string,
	args: readonly string[],
	stdin: string | undefined,
	environment: NodeJS.ProcessEnv,
	workingDirectory: string,
	cancellationToken: CancellationToken,
): Promise<string> {
	const result = await exec.execute(executable, args, {
		cwd: workingDirectory,
		env: environment,
		cancellationToken,
		...(stdin === undefined ? {} : { stdin }),
	});
	if (result.returnCode !== 0) {
		throw new ToolExitError(
			`Auxiliary tool exited with code ${result.returnCode}`,
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
		return this.produceWithTool(
			'binary-disassembly',
			source,
			options,
			{
				workspaceFiles: { object: objectFilename },
				compilerArguments: (files, providerArguments) =>
					outputArguments('object', files.object, providerArguments),
				tool: disassembler.tool,
				toolArguments: (files) => disassembler.arguments(files.object),
				normalizeOutput: disassembler.normalizeOutput,
			},
			cancellationToken,
		);
	}

	/**
	 * Produces a compiler artifact, then feeds its temporary workspace files to an auxiliary tool.
	 * The optional producer-data hook runs between those two steps and is retained on the result.
	 */
	async produceWithTool(
		kind: ArtifactKind,
		source: Uri,
		options: CompileOptions,
		spec: SecondaryToolSpec,
		cancellationToken: CancellationToken,
	): Promise<RawArtifact> {
		return withTemporaryDirectory('coglens-', async (temporaryDirectory) => {
			const files = Object.freeze(
				Object.fromEntries(
					Object.entries(spec.workspaceFiles).map(([name, filename]) => [name, path.join(temporaryDirectory, filename)]),
				),
			);
			const { invocation, result: compilerResult } = await this.run(
				source,
				options,
				(providerArguments) => spec.compilerArguments(files, providerArguments),
				cancellationToken,
			);
			const producerData = await spec.producerData?.(files);
			const tool = this.profile.tools[spec.tool];
			if (!tool) {
				throw new Error(`${this.profile.displayName} has no ${spec.tool} auxiliary tool.`);
			}

			const toolArguments = spec.toolArguments(files);
			this.reportInvocation(options, invocation, tool.executable, toolArguments);
			this.host.log(`Command: ${tool.executable} ${toolArguments.join(' ')}`);
			const toolResult = await exec.execute(tool.executable, toolArguments, {
				cwd: invocation.workingDirectory,
				env: invocation.preparedEnvironment,
				cancellationToken,
			});
			if (toolResult.returnCode !== 0) {
				throw new ToolExitError(
					`Auxiliary tool exited with code ${toolResult.returnCode}`,
					toolResult.returnCode,
					toolResult.stdout,
					toolResult.stderr,
				);
			}

			const inputMetadata = await this.collectDependencyInputs(
				source,
				invocation,
				temporaryDirectory,
				cancellationToken,
			);
			const artifact = this.buildRawArtifact(
				kind,
				spec.normalizeOutput ? spec.normalizeOutput(toolResult.stdout) : toolResult.stdout,
				[compilerResult.stderr, compilerResult.stdout, toolResult.stderr].join('\n'),
				source,
				invocation,
				inputMetadata,
				tool.executable,
				toolArguments,
			);
			return {
				...artifact,
				...(producerData === undefined ? {} : { producerData }),
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

	/** Parses output using the diagnostic grammar selected by this toolchain definition. */
	parseDiagnostics(output: string, source: Uri, workingDirectory: string): readonly CompileDiagnostic[] {
		return this.definition.parseDiagnostics(output, source, workingDirectory);
	}

	parseBinaryDisassembly(rawDisassembly: string, options: DisplayOptions): ParsedAsmResult {
		const filters: ParseFiltersAndOutputOptions = { ...options, binary: true };
		return this.binaryAsmParser.process(rawDisassembly, filters);
	}

	classifyAssemblyInstruction(instruction: string): InstructionType | undefined {
		return this.cfgParser?.classifyInstruction(instruction);
	}

	/** Parses assembly CFG input with this backend's configured dialect parser. */
	parseAssemblyControlFlowGraph(lines: readonly AssemblyLine[]): GraphParseResult {
		if (!this.cfgParser) {
			throw new Error(`${this.profile.displayName} has no assembly CFG parser.`);
		}
		return this.cfgParser.parse(lines);
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
			diagnostics: this.parseDiagnostics(diagnosticOutput, source, invocation.workingDirectory),
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

		const providerArguments = this.definition.stripOwnedArguments(
			[...this.profile.defaultArguments, ...(options.args ?? [])],
			source.fsPath,
			workingDirectory,
		);

		const compilerArguments = ownedArguments(providerArguments);
		const argumentsList = this.definition.assembleArguments
			? this.definition.assembleArguments(compilerArguments, providerArguments, source.fsPath)
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
		return executeTextTool(rawAssembly, this.profile.tools.demangler, environment, workingDirectory, cancellationToken);
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

/** Reads an artifact file only when it is within the backend's defensive size limit. */
export async function readBoundedArtifactBuffer(filename: string): Promise<Buffer> {
	const stat = await fs.promises.stat(filename);
	if (stat.size > maxArtifactFileBytes) {
		throw artifactFileLimitError();
	}
	return fs.promises.readFile(filename);
}

function artifactFileLimitError(): exec.ExecError {
	return new exec.ExecError('output-limit', `Toolchain output file exceeded the ${maxArtifactFileBytes}-byte limit`);
}
