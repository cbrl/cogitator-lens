import fs from 'fs';
import path from 'path';
import type { CancellationToken, Uri } from 'vscode';
import { AsmParser } from '../vendor/lib/parsers/asm-parser.js';
import { listingPropertyGetter, perListingLineLimit } from '../compilation/listing-limit.js';
import type { ParseFiltersAndOutputOptions } from '../vendor/types/features/filters.interfaces.js';
import type { ParsedAsmResult } from '../vendor/types/asmresult/asmresult.interfaces.js';
import type {
	ToolchainProfile,
	CompileOptions,
	DisplayOptions,
	ProductionOptions,
	ProducedArtifact,
	AuxiliaryTool,
	InvocationDetails,
} from '../types/index.js';
import * as exec from '../exec.js';
import { withTemporaryDirectory } from '../temporary-directory.js';
import type { ToolchainDefinition } from './toolchain-contracts.js';
import { snapshotArtifactInputs, type ArtifactInputMetadata } from '../compilation/artifact-inputs.js';
import { parseWithMainSource, type MainSource } from '../artifacts/assembly/main-source.js';
import { withoutLibraryFunctions } from '../artifacts/binary-disassembly/library-functions.js';
import { withoutTerminalEscapes } from '../diagnostics.js';
import type { InstructionType } from '../artifacts/control-flow-graph/parsers/instruction-sets.js';
import type { AssemblyCfgParser } from '../artifacts/control-flow-graph/parsers/assembly-cfg-parser.js';
import type { AssemblyLine } from '../artifacts/control-flow-graph/parsers/assembly-line.js';
import type { GraphParseResult } from '../artifacts/control-flow-graph/control-flow-graph-model.js';
import { withSourcePaths, writeSourceOverlay, type PreparedOverlay } from './source-overlay.js';
import { sameLocalFile } from '../file-identity.js';

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
	/** Runs while the workspace files still exist. */
	readonly normalizeOutput?: (output: string, files: Readonly<Record<string, string>>) => string | Promise<string>;
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
	/** Creates a filter for the stdout lines of one run, which drops output before it is kept. */
	readonly stdoutLineFilter?: (sourcePath: string, workingDirectory: string) => (line: string) => boolean;
}

export interface DependencyCollectionSpec {
	/** Name reserved inside the backend's per-invocation temporary directory. */
	readonly outputFilename: string;
	/**
	 * Arguments that make the main compile also write the dependency file, so no second compile
	 * is necessary. An empty list means that this compiler cannot do it. When the file is missing
	 * or lists nothing, the companion invocation runs.
	 */
	readonly inlineArguments?: (outputFile: string, profile: ToolchainProfile) => readonly string[];
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
			return executeTextToolInvocation(
				tool.executable,
				[],
				input,
				environment,
				workingDirectory,
				cancellationToken,
			);
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
	const result = await executeChecked('Auxiliary tool', executable, args, {
		cwd: workingDirectory,
		env: environment,
		cancellationToken,
		...(stdin === undefined ? {} : { stdin }),
	});
	return result.stdout;
}

/** Runs a tool and throws a ToolExitError when it exits with a non-zero code. */
async function executeChecked(
	description: string,
	executable: string,
	args: readonly string[],
	options: exec.ExecOptions,
	acceptOutputOnError = false,
): Promise<exec.ExecResult> {
	const result = await exec.execute(executable, args, options);
	if (result.returnCode !== 0 && !(acceptOutputOnError && result.stdout)) {
		throw new ToolExitError(
			`${description} exited with code ${result.returnCode}`,
			result.returnCode,
			result.stdout,
			result.stderr,
		);
	}
	return result;
}

/**
 * Translates display options into the vendored parser's filters, which name what to remove.
 * Filenames are never masked, because source mapping needs them.
 */
function parseFilters(options: DisplayOptions): ParseFiltersAndOutputOptions {
	return {
		labels: !options.showUnusedLabels,
		libraryCode: !options.showLibraryCode,
		directives: !options.showDirectives,
		commentOnly: !options.showCommentOnlyLines,
		trim: options.trim,
		dontMaskFilenames: true,
	};
}

interface PreparedInvocation {
	readonly workingDirectory: string;
	readonly preparedEnvironment: NodeJS.ProcessEnv;
	readonly argumentsList: readonly string[];
	readonly providerArguments: readonly string[];
	readonly overriddenNames: readonly string[];
	readonly environmentVariableNames: readonly string[];
	/** A monotonic time for the duration. */
	readonly started: number;
	/** The Unix epoch time in milliseconds, for comparison with file modification times. */
	readonly startedAt: number;
	/** The dependency file that the main compile writes, when the compiler can do it. */
	readonly inlineDependencyFile?: string;
	/** The file with the unsaved text, when the compile reads it in place of the saved source. */
	readonly overlay?: PreparedOverlay;
}

interface ToolchainRun {
	readonly invocation: PreparedInvocation;
	readonly result: exec.ExecResult;
}

export class ToolchainBackend {
	readonly profile: ToolchainProfile;
	readonly definition: ToolchainDefinition;
	private readonly host: ToolchainHost;
	private readonly asmParser?: AsmParser;
	// Binary disassembly is always GNU objdump-style text (GNU/LLVM objdump, or dumpbin
	// normalized to that shape by binary-disassembly-producer.ts), regardless of which
	// dialect `asmParser` handles for textual assembly. Parsing it with a dedicated plain
	// `AsmParser` keeps that independent of a backend's assembly dialect (e.g. MSVC's
	// `VcAsmParser`, whose own binary-mode parsing is an unimplemented upstream stub).
	// The parser reads the listing line limit when it is made, so a new limit makes a new parser.
	private readonly binaryAsmParser: () => AsmParser;
	private readonly cfgParser?: AssemblyCfgParser;

	constructor(profile: ToolchainProfile, definition: ToolchainDefinition, host: ToolchainHost) {
		this.profile = profile;
		this.definition = definition;
		this.host = host;
		this.asmParser = definition.createParser?.();
		this.binaryAsmParser = perListingLineLimit(
			() => definition.createBinaryParser?.() ?? new AsmParser(listingPropertyGetter),
		);
		this.cfgParser = definition.createCfgParser?.();
	}

	async produceAssembly(
		source: Uri,
		options: CompileOptions,
		cancellationToken: CancellationToken,
	): Promise<ProducedArtifact> {
		if (!this.definition.outputArguments || !this.asmParser) {
			throw new Error(`${this.profile.displayName} has no assembly production capability.`);
		}
		const outputArguments = this.definition.outputArguments;
		return this.produceArtifactWithTransform(
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

	/**
	 * Produces a compiler artifact, then feeds its temporary workspace files to an auxiliary tool.
	 * The optional producer-data hook runs between those two steps and is retained on the result.
	 */
	async produceWithTool(
		source: Uri,
		options: CompileOptions,
		spec: SecondaryToolSpec,
		cancellationToken: CancellationToken,
	): Promise<ProducedArtifact> {
		return withTemporaryDirectory('coglens-', async (temporaryDirectory) => {
			const files = Object.freeze(
				Object.fromEntries(
					Object.entries(spec.workspaceFiles).map(([name, filename]) => [
						name,
						path.join(temporaryDirectory, filename),
					]),
				),
			);
			const { invocation, result: compilerResult } = await this.run(
				source,
				options,
				(providerArguments) => spec.compilerArguments(files, providerArguments),
				cancellationToken,
				temporaryDirectory,
			);
			const producerData = await spec.producerData?.(files);
			const tool = this.profile.tools[spec.tool];
			if (!tool) {
				throw new Error(`${this.profile.displayName} has no ${spec.tool} auxiliary tool.`);
			}

			const toolArguments = spec.toolArguments(files);
			this.reportInvocation(options, invocation, tool.executable, toolArguments);
			this.host.log(`Command: ${tool.executable} ${toolArguments.join(' ')}`);
			const toolResult = await withOverlayFailurePaths(
				invocation,
				executeChecked('Auxiliary tool', tool.executable, toolArguments, {
					cwd: invocation.workingDirectory,
					env: invocation.preparedEnvironment,
					cancellationToken,
				}),
			);

			const inputMetadata = await this.collectDependencyInputs(
				source,
				invocation,
				temporaryDirectory,
				cancellationToken,
			);
			const artifact = this.buildRawArtifact(
				spec.normalizeOutput ? await spec.normalizeOutput(toolResult.stdout, files) : toolResult.stdout,
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
		source: Uri,
		options: CompileOptions,
		spec: ArtifactOutputSpec,
		cancellationToken: CancellationToken,
	): Promise<ProducedArtifact> {
		return this.produceArtifactWithTransform(source, options, spec, cancellationToken, (text) => text);
	}

	private async produceArtifactWithTransform(
		source: Uri,
		options: CompileOptions,
		spec: ArtifactOutputSpec,
		cancellationToken: CancellationToken,
		transform: (text: string, invocation: PreparedInvocation) => Promise<string> | string,
	): Promise<ProducedArtifact> {
		return withTemporaryDirectory('coglens-', async (temporaryDirectory) => {
			const outputFile =
				typeof spec.output === 'object' ? path.join(temporaryDirectory, spec.output.filename) : '';
			const { invocation, result } = await this.run(
				source,
				options,
				(providerArguments) => spec.arguments(outputFile, temporaryDirectory, providerArguments),
				cancellationToken,
				temporaryDirectory,
				spec.acceptOutputOnError,
				spec.environment?.(temporaryDirectory),
				spec.stdoutLineFilter,
			);
			// The selected output holds the artifact text. The other streams hold diagnostics.
			const [rawText, diagnosticOutput] =
				spec.output === 'stdout'
					? [result.stdout, result.stderr]
					: spec.output === 'stderr'
						? [result.stderr, result.stdout]
						: [
								await readBoundedArtifactFile(outputFile, spec.output.optional),
								`${result.stderr}\n${result.stdout}`,
							];
			const text = await transform(rawText, invocation);
			const inputMetadata = await this.collectDependencyInputs(
				source,
				invocation,
				temporaryDirectory,
				cancellationToken,
			);
			return this.buildRawArtifact(text, diagnosticOutput, source, invocation, inputMetadata);
		});
	}

	/** Parses an assembly listing. The main source decides what hiding library code keeps. */
	parseAssembly(rawAssembly: string, options: DisplayOptions, mainSource: MainSource): ParsedAsmResult {
		if (!this.asmParser) {
			throw new Error(`${this.profile.displayName} has no assembly parser.`);
		}
		const parser = this.asmParser;
		return parseWithMainSource(rawAssembly, mainSource, (assembly) =>
			parser.process(assembly, parseFilters(options)),
		);
	}

	/**
	 * Parses disassembler output. The main source decides what hiding library code keeps, and the
	 * library functions are removed before parsing. The parser's own filter stays off. It also removes
	 * each line without line information, such as all of a function that has no line table.
	 */
	parseBinaryDisassembly(rawDisassembly: string, options: DisplayOptions, mainSource: MainSource): ParsedAsmResult {
		const text = options.showLibraryCode ? rawDisassembly : withoutLibraryFunctions(rawDisassembly, mainSource);
		return this.binaryAsmParser().process(text, { ...parseFilters(options), libraryCode: false, binary: true });
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

	private async run(
		source: Uri,
		options: CompileOptions,
		ownedArguments: (providerArguments: readonly string[]) => readonly string[],
		cancellationToken: CancellationToken,
		temporaryDirectory: string,
		acceptOutputOnError = false,
		invocationEnvironment: Readonly<Record<string, string>> = {},
		stdoutLineFilter?: ArtifactOutputSpec['stdoutLineFilter'],
	): Promise<ToolchainRun> {
		const invocation = await this.prepareInvocation(
			source,
			options,
			ownedArguments,
			cancellationToken,
			temporaryDirectory,
			invocationEnvironment,
		);
		const unsaved = invocation.overlay ? ' from its unsaved text' : '';
		this.host.log(`Producing an artifact for ${source.fsPath}${unsaved} with ${this.profile.displayName}`);
		this.host.log(`Command: ${this.profile.executable} ${invocation.argumentsList.join(' ')}`);
		this.host.log(`Environment overrides: ${invocation.overriddenNames.join(', ') || '(none)'}`, 'debug');

		const result = await withOverlayFailurePaths(
			invocation,
			executeChecked(
				'Toolchain',
				this.profile.executable,
				invocation.argumentsList,
				{
					cwd: invocation.workingDirectory,
					env: invocation.preparedEnvironment,
					cancellationToken,
					...(stdoutLineFilter
						? { stdoutLineFilter: stdoutLineFilter(source.fsPath, invocation.workingDirectory) }
						: {}),
				},
				acceptOutputOnError,
			),
		);
		return { invocation, result };
	}

	private buildRawArtifact(
		text: string,
		diagnosticOutput: string,
		source: Uri,
		invocation: PreparedInvocation,
		inputMetadata: ArtifactInputMetadata,
		executable = this.profile.executable,
		args: readonly string[] = invocation.argumentsList,
	): ProducedArtifact {
		return {
			text: overlayToSourcePaths(invocation, text),
			diagnostics: this.definition.parseDiagnostics(
				withoutTerminalEscapes(overlayToSourcePaths(invocation, diagnosticOutput)),
				source,
				invocation.workingDirectory,
			),
			durationMs: performance.now() - invocation.started,
			generatedAt: Date.now(),
			...inputMetadata,
			command: invocationDetails(invocation, executable, args),
		};
	}

	private async prepareInvocation(
		source: Uri,
		options: CompileOptions,
		ownedArguments: (providerArguments: readonly string[]) => readonly string[],
		cancellationToken: CancellationToken,
		temporaryDirectory: string,
		invocationEnvironment: Readonly<Record<string, string>> = {},
	): Promise<PreparedInvocation> {
		const workingDirectory = options.workingDirectory ?? path.dirname(source.fsPath);
		const environment = {
			...process.env,
			...this.profile.environment,
			...options.env,
			...invocationEnvironment,
		};
		const providerArguments = this.definition.stripOwnedArguments(
			[...this.profile.defaultArguments, ...(options.args ?? [])],
			source.fsPath,
			workingDirectory,
		);
		const preparedEnvironment = this.definition.prepareEnvironment
			? await this.definition.prepareEnvironment(this.profile, environment, cancellationToken, providerArguments)
			: environment;

		// Unsaved text goes into a file of its own. The compiler reads that file in place of the source.
		const overlaySpec = this.definition.sourceOverlay;
		const overlay =
			options.sourceOverlay && overlaySpec
				? await writeSourceOverlay(overlaySpec, source.fsPath, options.sourceOverlay, temporaryDirectory)
				: undefined;

		// The main compile also lists its inputs when the compiler can do it.
		const dependencies = this.definition.dependencyCollection;
		const inlineDependencyFile = dependencies && path.join(temporaryDirectory, dependencies.outputFilename);
		const inlineDependencyArguments =
			(inlineDependencyFile && dependencies.inlineArguments?.(inlineDependencyFile, this.profile)) || [];
		const artifactArguments = ownedArguments(providerArguments);
		const compilerArguments = [
			...(overlay && overlaySpec?.rewriteArguments
				? overlaySpec.rewriteArguments(artifactArguments)
				: artifactArguments),
			...(overlay?.invocation.arguments ?? []),
			...inlineDependencyArguments,
		];
		const inputPath = overlay?.invocation.inputPath ?? source.fsPath;
		// The folder of the source comes after the default arguments of the toolchain, and before the
		// arguments of the project, so it is the first include folder of the project.
		const leading = overlay?.invocation.leadingArguments ?? [];
		const toolchainArgumentCount =
			leading.length > 0
				? this.definition.stripOwnedArguments(this.profile.defaultArguments, source.fsPath, workingDirectory)
						.length
				: 0;
		const leadingProviderArguments = [
			...providerArguments.slice(0, toolchainArgumentCount),
			...leading,
			...providerArguments.slice(toolchainArgumentCount),
		];
		const argumentsList = [
			...(this.definition.assembleArguments
				? this.definition.assembleArguments(compilerArguments, leadingProviderArguments, inputPath)
				: [...leadingProviderArguments, ...compilerArguments, inputPath]),
			...(overlay?.invocation.trailingArguments ?? []),
		];

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
			startedAt: Date.now(),
			...(inlineDependencyArguments.length > 0 ? { inlineDependencyFile } : {}),
			...(overlay ? { overlay } : {}),
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
		options.onInvocation?.(invocationDetails(invocation, executable, args));
	}

	private async collectDependencyInputs(
		source: Uri,
		invocation: PreparedInvocation,
		temporaryDirectory: string,
		cancellationToken: CancellationToken,
	): Promise<ArtifactInputMetadata> {
		const { overlay, workingDirectory } = invocation;
		// The hash of unsaved text is in the cache key, so the source and its overlay file are no inputs.
		const isSource = (input: string): boolean =>
			overlay !== undefined &&
			(sameLocalFile(input, overlay.files.overlayPath, workingDirectory) ||
				sameLocalFile(input, source.fsPath, workingDirectory));
		const snapshot = (dependencies: readonly string[]): Promise<ArtifactInputMetadata> =>
			snapshotArtifactInputs(
				source.fsPath,
				dependencies.filter((input) => !isSource(input)),
				dependencies.length > 0 ? 'complete' : 'source-only',
				workingDirectory,
				invocation.startedAt,
				{ includeSource: overlay === undefined },
			);
		const spec = this.definition.dependencyCollection;
		if (!spec) {
			return snapshot([]);
		}
		const inlineDependencies = invocation.inlineDependencyFile
			? await readDependencyFile(spec, invocation.inlineDependencyFile, workingDirectory)
			: [];
		// A compile of unsaved text runs often, so it does not start a second run for its inputs.
		if (inlineDependencies.length > 0 || overlay) {
			return snapshot(inlineDependencies);
		}
		const dependencyFile = path.join(temporaryDirectory, spec.outputFilename);
		const dependencyArguments = spec.arguments(dependencyFile, temporaryDirectory, invocation.providerArguments);
		this.host.log(`The compile listed no inputs, so a second run of ${this.profile.displayName} lists them.`);

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
			return snapshot(
				result.returnCode === 0
					? spec.parse(await readBoundedArtifactFile(dependencyFile), invocation.workingDirectory)
					: [],
			);
		} catch (error) {
			if (
				cancellationToken.isCancellationRequested ||
				(error instanceof exec.ExecError && (error.kind === 'cancelled' || error.kind === 'timeout'))
			) {
				throw error;
			}
			return snapshot([]);
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
		return executeTextTool(
			rawAssembly,
			this.profile.tools.demangler,
			environment,
			workingDirectory,
			cancellationToken,
		);
	}
}

/** Output of a compile of unsaved text, with the source in place of the overlay file. */
function overlayToSourcePaths(invocation: PreparedInvocation, text: string): string {
	return invocation.overlay ? withSourcePaths(text, invocation.overlay.files, invocation.workingDirectory) : text;
}

/** Waits for a tool. Its failure output names the source in place of the overlay file. */
async function withOverlayFailurePaths<T>(invocation: PreparedInvocation, run: Promise<T>): Promise<T> {
	try {
		return await run;
	} catch (error) {
		if (!invocation.overlay) {
			throw error;
		}
		const map = (text: string): string => overlayToSourcePaths(invocation, text);
		if (error instanceof ToolExitError) {
			throw new ToolExitError(error.message, error.returnCode, map(error.stdout), map(error.stderr));
		}
		if (error instanceof exec.ExecError) {
			throw new exec.ExecError(error.kind, error.message, map(error.stdout), map(error.stderr));
		}
		throw error;
	}
}

function invocationDetails(
	invocation: PreparedInvocation,
	executable: string,
	args: readonly string[],
): InvocationDetails {
	return Object.freeze({
		executable,
		args: Object.freeze([...args]),
		cwd: invocation.workingDirectory,
		environmentVariableNames: Object.freeze([...invocation.environmentVariableNames]),
	});
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
		const { maxOutputBytes: maxArtifactFileBytes } = exec.currentProcessLimits();
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

/** The inputs in a dependency file that the main compile wrote, or none when it wrote no file. */
async function readDependencyFile(
	spec: DependencyCollectionSpec,
	filename: string,
	workingDirectory: string,
): Promise<readonly string[]> {
	try {
		return spec.parse(await readBoundedArtifactFile(filename), workingDirectory);
	} catch {
		return [];
	}
}

/** Reads an artifact file only when it is within the backend's defensive size limit. */
export async function readBoundedArtifactBuffer(filename: string): Promise<Buffer> {
	const stat = await fs.promises.stat(filename);
	if (stat.size > exec.currentProcessLimits().maxOutputBytes) {
		throw artifactFileLimitError();
	}
	return fs.promises.readFile(filename);
}

function artifactFileLimitError(): exec.ExecError {
	return new exec.ExecError('output-limit', exec.outputLimitMessage(exec.currentProcessLimits().maxOutputBytes));
}
