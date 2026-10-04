import fs from 'fs';
import path from 'path';
import type { CancellationToken, Uri } from 'vscode';
import type { ArtifactKind, ArtifactListingSyntax, ArtifactRenderer } from '../artifacts/core/artifact-contracts.js';
import {
	binaryDisassemblyProducer,
	type BinaryDisassembler,
} from '../artifacts/binary-disassembly/binary-disassembly-producer.js';
import {
	controlFlowGraphRenderer,
	type GraphParser,
} from '../artifacts/control-flow-graph/control-flow-graph-renderer.js';
import { toAssemblyLines } from '../artifacts/control-flow-graph/parsers/assembly-line.js';
import type {
	CompileOptions,
	AuxiliaryTool,
	IntelSyntaxSupport,
	ProducedArtifact,
	ToolchainProfile,
} from '../types/index.js';
import type { AsmParser } from '../vendor/lib/parsers/asm-parser.js';
import type { AssemblyCfgParser } from '../artifacts/control-flow-graph/parsers/assembly-cfg-parser.js';
import type { DependencyCollectionSpec, ToolchainBackend } from './toolchain-backend.js';
import type { DiagnosticParser } from '../diagnostics.js';

/**
 * Runs a toolchain and returns its raw output. The compilation service sets
 * the artifact kind on the result, so one producer can serve several kinds.
 */
export type ArtifactProducer = (
	backend: ToolchainBackend,
	source: Uri,
	options: CompileOptions,
	cancellationToken: CancellationToken,
) => Promise<ProducedArtifact>;

/** An auxiliary tool that must be detected or configured before an artifact can be produced. */
export interface RequiredTool {
	/** The key of the tool in the toolchain profile. */
	readonly name: string;
	readonly label: string;
}

/** How a toolchain produces and renders one artifact kind, or one selectable output of it. */
export interface ArtifactImplementation {
	readonly producer: ArtifactProducer;
	/** Overrides the default renderer of the artifact kind. */
	readonly renderer?: ArtifactRenderer;
	/** Overrides the default listing syntax of the artifact kind. */
	readonly listingSyntax?: ArtifactListingSyntax;
	readonly requiredTools?: readonly RequiredTool[];
}

/** One selectable output of an artifact kind, such as the LLVM IR or assembly source of a graph. */
export interface ArtifactOutput extends ArtifactImplementation {
	/** Stable identifier persisted in artifact document URIs and production cache keys. */
	readonly id: string;
	readonly label: string;
	readonly description: string;
}

/** A toolchain supports an artifact kind with one implementation, or with a list of selectable outputs. */
export type ArtifactSupport =
	| (ArtifactImplementation & { readonly outputs?: never })
	| { readonly outputs: readonly [ArtifactOutput, ...ArtifactOutput[]] };

export interface ToolchainDefinition {
	readonly executablePattern: RegExp;
	/** Parses only the diagnostic formats emitted by this toolchain and its host compiler. */
	readonly parseDiagnostics: DiagnosticParser;
	/** Selects this definition when multiple definitions match the same executable name. */
	readonly disambiguate?: (versionOutput: string, platform: NodeJS.Platform) => boolean;
	readonly languageIdentifiers: readonly string[];
	readonly intelSyntax?: IntelSyntaxSupport;
	readonly intelArguments?: readonly string[];
	readonly includeFlag?: string;
	readonly defineFlag?: string;
	readonly objectFilename?: string;
	readonly outputArguments?: (
		target: 'assembly' | 'object',
		outputFile: string,
		providerArguments: readonly string[],
	) => readonly string[];
	/** Combines extension-owned and provider arguments with the source path. */
	readonly assembleArguments?: (
		ownedArguments: readonly string[],
		providerArguments: readonly string[],
		sourcePath: string,
	) => readonly string[];
	readonly stripOwnedArguments: (
		args: readonly string[],
		sourceFile: string,
		workingDirectory: string,
	) => readonly string[];
	readonly createParser?: () => AsmParser;
	readonly createBinaryParser?: () => AsmParser;
	readonly createCfgParser?: () => AssemblyCfgParser;
	readonly prepareEnvironment?: (
		profile: ToolchainProfile,
		environment: NodeJS.ProcessEnv,
		cancellationToken: CancellationToken,
	) => Promise<NodeJS.ProcessEnv>;
	/** Omit when the toolchain cannot enumerate inputs beyond the main source. */
	readonly dependencyCollection?: DependencyCollectionSpec;
	/** Omit when the toolchain has no auxiliary tools. */
	readonly discoverTools?: (executable: string) => Readonly<Record<string, AuxiliaryTool>>;
	/** The artifact kinds this toolchain supports. A missing kind is unsupported. */
	readonly artifacts: Readonly<Partial<Record<ArtifactKind, ArtifactSupport>>>;
}

/** Places the first owned argument (a subcommand) before the provider arguments. */
export const subcommandFirst: NonNullable<ToolchainDefinition['assembleArguments']> = (owned, provider, sourcePath) => [
	...owned.slice(0, 1),
	...provider,
	...owned.slice(1),
	sourcePath,
];

/** Produces the compiler's assembly listing with the toolchain's output arguments. */
export const assemblyProducer: ArtifactProducer = (backend, source, options, cancellationToken) =>
	backend.produceAssembly(source, options, cancellationToken);

export const compilerAssembly: ArtifactImplementation = { producer: assemblyProducer };

/** Disassembles a compiled object file with the named auxiliary disassembler. */
export const binaryDisassembly = (label: string, disassembler: BinaryDisassembler): ArtifactImplementation => ({
	producer: binaryDisassemblyProducer(disassembler),
	requiredTools: [{ name: disassembler.tool, label }],
});

/** Describes one selectable CFG source and the parser that turns it into graphs. */
export const controlFlowGraphOutput = (
	id: string,
	label: string,
	description: string,
	producer: ArtifactProducer,
	parseGraphs: GraphParser,
): ArtifactOutput => ({ id, label, description, producer, renderer: controlFlowGraphRenderer(parseGraphs) });

export const assemblyControlFlowGraphOutput = controlFlowGraphOutput(
	'assembly',
	'Assembly CFG',
	'Build a machine-level graph from the compiler assembly listing.',
	assemblyProducer,
	(raw, options, context) => {
		const parsedAssembly = context.backend.parseAssembly(raw.text, options);
		const lines = toAssemblyLines(parsedAssembly.asm, context.source.uri.toString(), raw.command.cwd);
		return context.backend.parseAssemblyControlFlowGraph(lines);
	},
);

/** Returns a path only when it currently exists on disk. */
export const existingFile = (candidate: string): string | undefined =>
	fs.existsSync(candidate) ? candidate : undefined;

export const sibling = (executable: string, name: string): string => path.join(path.dirname(executable), name);

export const toolExecutableName = (name: string): string => (process.platform === 'win32' ? `${name}.exe` : name);

export const executableOnPath = (name: string): string | undefined => {
	for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
		if (directory) {
			const candidate = path.join(directory, name);
			if (fs.existsSync(candidate)) {
				return candidate;
			}
		}
	}
	return undefined;
};

/** Locates a tool next to its compiler first, then falls back to the process PATH. */
export const siblingOrPath = (executable: string, name: string): string | undefined =>
	existingFile(sibling(executable, name)) ?? executableOnPath(name);

export const discoveredTools = (
	candidates: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, AuxiliaryTool>> =>
	Object.freeze(
		Object.fromEntries(
			Object.entries(candidates).flatMap(([name, executable]) =>
				executable ? [[name, Object.freeze({ executable, inputMode: 'stdin' as const })]] : [],
			),
		),
	);

export interface AuxiliaryToolNames {
	readonly demangler?: string;
	readonly disassembler?: string;
}

/** Creates a sibling-or-PATH auxiliary-tool discovery function for a toolchain definition. */
export function toolDiscoverer(
	names: AuxiliaryToolNames,
): (executable: string) => Readonly<Record<string, AuxiliaryTool>> {
	return (executable) =>
		discoveredTools({
			demangler: names.demangler ? siblingOrPath(executable, toolExecutableName(names.demangler)) : undefined,
			disassembler: names.disassembler
				? siblingOrPath(executable, toolExecutableName(names.disassembler))
				: undefined,
		});
}
