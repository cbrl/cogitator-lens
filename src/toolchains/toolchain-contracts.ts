import fs from 'fs';
import path from 'path';
import type { CancellationToken, Uri } from 'vscode';
import type {
	ArtifactKind,
	ArtifactListingSyntax,
	ArtifactRenderContext,
} from '../artifacts/core/artifact-contracts.js';
import { artifactDefinitions, supportedArtifactKinds } from '../artifacts/core/artifact-definitions.js';
import { assemblyControlFlowGraphProducer } from '../artifacts/core/compiler-output-producer.js';
import type { GraphParseResult } from '../artifacts/control-flow-graph/control-flow-graph-model.js';
import { toAssemblyLines } from '../artifacts/control-flow-graph/parsers/assembly-line.js';
import type {
	CompileOptions,
	AuxiliaryTool,
	DisplayOptions,
	IntelSyntaxSupport,
	RawArtifact,
	RenderedArtifact,
	ToolchainProfile,
} from '../types/index.js';
import type { AsmParser } from '../vendor/lib/parsers/asm-parser.js';
import type { AssemblyCfgParser } from '../artifacts/control-flow-graph/parsers/assembly-cfg-parser.js';
import type { DependencyCollectionSpec, ToolchainBackend } from './toolchain-backend.js';
import type { DiagnosticParser } from '../diagnostics.js';

export const disassemblerToolName = 'disassembler';

export type ArtifactProducer = (
	backend: ToolchainBackend,
	source: Uri,
	options: CompileOptions,
	cancellationToken: CancellationToken,
) => Promise<RawArtifact>;

export interface ToolchainArtifactImplementation {
	readonly producer: ArtifactProducer;
	/** Overrides the artifact kind's default listing syntax for this toolchain's output. */
	readonly listingSyntax?: ArtifactListingSyntax;
	/** Optional toolchain-specific rendering action; otherwise the artifact default is used. */
	readonly renderer?: (raw: RawArtifact, options: DisplayOptions, context: ArtifactRenderContext) => RenderedArtifact;
	readonly requiredTool?: {
		readonly name: string;
		readonly label: string;
	};
	readonly requiredTools?: readonly {
		readonly name: string;
		readonly label: string;
	}[];
}

export interface ToolchainArtifactOutput extends ToolchainArtifactImplementation {
	/** Stable identifier persisted in artifact document URIs and production cache keys. */
	readonly id: string;
	readonly label: string;
	readonly description: string;
	readonly parseGraphs?: (
		raw: RawArtifact,
		options: DisplayOptions,
		context: ArtifactRenderContext,
	) => GraphParseResult;
}

export type ResolvedToolchainArtifactCell =
	| (ToolchainArtifactImplementation & { readonly status: 'available'; readonly id?: never })
	| (ToolchainArtifactOutput & { readonly status: 'available' })
	| {
			readonly status: 'unavailable' | 'unsupported';
			readonly explanation: string;
	  };

export type ToolchainArtifactCell =
	| (ToolchainArtifactImplementation & {
			readonly status: 'available';
			readonly outputs?: never;
	  })
	| {
			readonly status: 'available';
			readonly outputs: readonly [ToolchainArtifactOutput, ...ToolchainArtifactOutput[]];
	  }
	| {
			readonly status: 'unavailable' | 'unsupported';
			readonly explanation: string;
	  };

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
	readonly artifacts: Readonly<Record<ArtifactKind, ToolchainArtifactCell>>;
}

/** Places the first owned argument (a subcommand) before the provider arguments. */
export const subcommandFirst: NonNullable<ToolchainDefinition['assembleArguments']> = (owned, provider, sourcePath) => [
	...owned.slice(0, 1),
	...provider,
	...owned.slice(1),
	sourcePath,
];

export const assemblyCell: ToolchainArtifactCell = {
	status: 'available',
	producer: (backend, source, options, cancellationToken) =>
		backend.produceAssembly(source, options, cancellationToken),
};

/** Creates a binary-disassembly cell that requires the named disassembler. */
export const binaryCell = (label: string, producer: ArtifactProducer): ToolchainArtifactCell => ({
	status: 'available',
	producer,
	requiredTool: {
		name: disassemblerToolName,
		label,
	},
});

/** Creates a cell whose artifact flavor must be selected from a non-empty output list. */
export function outputArtifactCell(
	outputs: readonly [ToolchainArtifactOutput, ...ToolchainArtifactOutput[]],
): ToolchainArtifactCell {
	return Object.freeze({
		status: 'available',
		outputs: Object.freeze([...outputs]) as readonly [ToolchainArtifactOutput, ...ToolchainArtifactOutput[]],
	});
}

/** Describes one selectable CFG source and the parser that turns it into graphs. */
export const controlFlowGraphOutput = (
	id: string,
	label: string,
	description: string,
	producer: ArtifactProducer,
	parseGraphs: NonNullable<ToolchainArtifactOutput['parseGraphs']>,
): ToolchainArtifactOutput => Object.freeze({ id, label, description, producer, parseGraphs });

export const assemblyControlFlowGraphOutput = controlFlowGraphOutput(
	'assembly',
	'Assembly CFG',
	'Build a machine-level graph from the compiler assembly listing.',
	assemblyControlFlowGraphProducer,
	(raw, options, context) => {
		const parsedAssembly = context.backend.parseAssembly(raw.text, options);
		const lines = toAssemblyLines(parsedAssembly.asm, context.source.uri.toString(), raw.command.cwd);
		return context.backend.parseAssemblyControlFlowGraph(lines);
	},
);

/** Creates the standard unsupported cell for a toolchain with no producer for a kind. */
export function unsupportedCell(kind: ArtifactKind): ToolchainArtifactCell {
	return {
		status: 'unsupported',
		explanation: `This toolchain has no ${artifactDefinitions[kind].label.toLowerCase()} producer.`,
	};
}

/** Completes a toolchain's cell table by marking every unoverridden artifact kind unsupported. */
export function artifactCells(
	overrides: Partial<Record<ArtifactKind, ToolchainArtifactCell>>,
): Readonly<Record<ArtifactKind, ToolchainArtifactCell>> {
	return Object.freeze(
		Object.fromEntries(supportedArtifactKinds.map((kind) => [kind, overrides[kind] ?? unsupportedCell(kind)])),
	) as Readonly<Record<ArtifactKind, ToolchainArtifactCell>>;
}

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
