/**
 * Compilation contracts shared by configuration providers and the toolchain
 * execution layer.
 */

import type { CancellationToken, Uri } from 'vscode';
import type { ArtifactOptions } from './artifact-options.js';
import type { ArtifactKind, ArtifactListingSyntax } from '../artifacts/core/artifact-contracts.js';
import { localFileComparisonKey, localFileUriComparisonKey } from '../file-identity.js';

export interface CompilationVariant {
	id: string;
	provider: string;
	project?: string;
	target?: string;
	configuration?: string;
	source: Uri;
	toolchainProfileId: string;
	workingDirectory: string;
	arguments: readonly string[];
	environment: Readonly<Record<string, string>>;
	displayLabel: string;
}

/** A user-authored compilation variant stored in workspace settings. */
export interface ManualCompilationVariantSettings {
	id: string;
	source: string;
	displayLabel: string;
	toolchainProfileId: string;
	workingDirectory: string;
	arguments: string[];
	environment: Record<string, string>;
	project?: string;
	target?: string;
	configuration?: string;
}

export interface ArtifactRequest {
	variant: CompilationVariant;
	artifactKind: ArtifactKind;
	/** Selects the compiler output used by output-backed artifact kinds. */
	artifactOutputId?: string;
	presetId: string;
	extraArguments: readonly string[];
	options: ArtifactOptions;
	cancellationToken: CancellationToken;
	/** Receives sanitized invocation metadata as soon as a tool is about to run. */
	onInvocation?: (details: InvocationDetails) => void;
	/**
	 * The unsaved text of the source. When the toolchain can, the compile reads it in place of the
	 * saved file.
	 */
	unsavedText?: string;
	/** The function whose output the compile prints, for a kind that requires a function filter. */
	functionFilter?: string;
}

/** Whether a compile read the unsaved text of its request, or why it read the saved file. */
export type UnsavedTextUse = { readonly read: true } | { readonly read: false; readonly reason: string };

export interface CompileDiagnostic {
	uri: Uri;
	line: number;
	column: number;
	severity: 'error' | 'warning' | 'information';
	message: string;
}

/** The command that produced an artifact. It holds environment variable names, never their values. */
export interface InvocationDetails {
	readonly executable: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly environmentVariableNames: readonly string[];
}

export interface ArtifactInputState {
	readonly uri: string;
	readonly size: number;
	readonly mtimeMs: number;
}

/** Tool output before the compilation service assigns its artifact kind. */
export interface ProducedArtifact {
	text: string;
	diagnostics: readonly CompileDiagnostic[];
	durationMs: number;
	/** Unix epoch milliseconds when tool output and dependency discovery completed. */
	generatedAt: number;
	command: InvocationDetails;
	readonly inputs: readonly ArtifactInputState[];
	readonly dependencyCoverage: 'complete' | 'source-only';
	/** Producer-owned metadata interpreted by the artifact's renderer. */
	readonly producerData?: unknown;
}

export interface RawArtifact extends ProducedArtifact {
	kind: ArtifactKind;
}

export interface RenderedArtifactLineSource {
	readonly file: string | null;
	readonly line: number | null;
	readonly column?: number;
	/**
	 * Optional exclusive end position for precise source highlighting.
	 * Lines are one-based and columns are zero-based, matching `line` and `column`.
	 */
	readonly endLine?: number;
	readonly endColumn?: number;
	readonly mainSource?: boolean;
}

export type OptimizationRemarkCategory = 'passed' | 'missed' | 'analysis';

export const optimizationRemarkCategories: readonly OptimizationRemarkCategory[] = Object.freeze([
	'passed',
	'missed',
	'analysis',
]);

/** Decoration style selected by an artifact renderer for an inline annotation. */
export type ArtifactLineAnnotationStyle =
	'optimization-passed' | 'optimization-missed' | 'optimization-analysis' | 'stack-usage';

export interface OptimizationRemarkLineAnnotation {
	readonly kind: 'optimization-remark';
	readonly category: OptimizationRemarkCategory;
	readonly message: string;
	/** Renderer-owned presentation text displayed beside the artifact line. */
	readonly text: string;
	readonly style: `optimization-${OptimizationRemarkCategory}`;
}

export type StackUsageQualifier = 'static' | 'dynamic' | 'dynamic-bounded' | 'vm';

export interface StackUsageLineAnnotation {
	readonly kind: 'stack-usage';
	readonly functionName: string;
	readonly value: number;
	readonly unit: 'bytes' | 'vm-slots';
	readonly qualifier: StackUsageQualifier;
	/** Renderer-owned presentation text displayed beside the artifact line. */
	readonly text: string;
	readonly style: 'stack-usage';
}

export type ArtifactLineAnnotation = OptimizationRemarkLineAnnotation | StackUsageLineAnnotation;

export interface RenderedArtifactLine {
	readonly text: string;
	readonly opcodes?: readonly string[];
	readonly address?: number;
	readonly disassembly?: string;
	readonly source?: RenderedArtifactLineSource | null;
	/** Typed analyses rendered by the editor without changing document text. */
	readonly annotations?: readonly ArtifactLineAnnotation[];
}

export interface ArtifactLink {
	readonly line: number;
	readonly startCharacter: number;
	readonly endCharacter: number;
	readonly targetLine: number;
	/** CFG edge kind when the reference is a statically resolved branch. */
	readonly edgeKind?: Extract<ControlFlowEdgeKind, 'unconditional' | 'true'>;
}

export interface ArtifactFold {
	readonly startLine: number;
	readonly endLine: number;
}

export interface ArtifactSymbol {
	readonly name: string;
	readonly line: number;
}

export type RenderedArtifactMetric = string | number | boolean;

export interface ControlFlowSourceLocation {
	/** A local source URI. Lines and columns are zero-based editor positions. */
	readonly uri: string;
	readonly line: number;
	readonly column: number;
	readonly endLine?: number;
	readonly endColumn?: number;
}

export type ControlFlowTerminal = 'return' | 'throw' | 'resume' | 'unreachable';

export type ControlFlowEdgeKind = 'unconditional' | 'true' | 'false' | 'fallthrough' | 'return' | 'exception';

export interface ControlFlowNode {
	readonly id: string;
	readonly label: string;
	readonly source?: ControlFlowSourceLocation;
	/** Zero-based line indexes in the compiler artifact used to derive this node. */
	readonly referencedArtifactLines?: readonly number[];
	readonly terminal?: ControlFlowTerminal;
}

export interface ControlFlowEdge {
	readonly from: string;
	readonly to: string;
	readonly kind: ControlFlowEdgeKind;
	readonly label?: string;
}

export interface ControlFlowGraph {
	readonly id: string;
	readonly label: string;
	readonly entryNodeId?: string;
	readonly nodes: readonly ControlFlowNode[];
	readonly edges: readonly ControlFlowEdge[];
}

export interface RenderedArtifactBase {
	readonly kind: ArtifactKind;
	readonly presentation: 'text' | 'graph';
	readonly diagnostics: readonly CompileDiagnostic[];
	readonly durationMs: number;
	readonly generatedAt: number;
	readonly command: InvocationDetails;
	readonly metrics: Readonly<Record<string, RenderedArtifactMetric>>;
	/** Whether the renderer dropped lines past its limit. */
	readonly truncated: boolean;
}

/** An instruction set that has its own instruction documentation. */
export type TargetArchitecture = 'x86' | 'aarch64' | 'arm32' | 'riscv64' | 'power' | 'ptx' | 'sass';

export interface RenderedTextArtifact extends RenderedArtifactBase {
	readonly presentation: 'text';
	readonly listingSyntax?: ArtifactListingSyntax;
	/**
	 * The instruction set of a native assembly listing, from the target of the compile. Without it,
	 * the documentation set is the one that covers the most mnemonics.
	 */
	readonly architecture?: TargetArchitecture;
	readonly lines: readonly RenderedArtifactLine[];
	readonly links: readonly ArtifactLink[];
	readonly folds: readonly ArtifactFold[];
	readonly symbols: readonly ArtifactSymbol[];
	/** The passes of an optimization pipeline, each with the line that names it. */
	readonly passes?: readonly PipelinePass[];
}

/** One pass of an optimization pipeline, and the text of the function before and after it. */
export interface PipelinePass {
	/** The zero-based line of the listing that names the pass. */
	readonly line: number;
	/** The one-based position of the pass in the pipeline. */
	readonly number: number;
	readonly name: string;
	/** Whether the pass works on machine code, after instruction selection. */
	readonly machine: boolean;
	readonly changed: boolean;
	readonly before: string;
	readonly after: string;
	/** The filename extension of the documents that compare the pass, which selects their language. */
	readonly extension: string;
}

export interface RenderedGraphArtifact extends RenderedArtifactBase {
	readonly presentation: 'graph';
	readonly graphs: readonly ControlFlowGraph[];
}

export type RenderedArtifact = RenderedTextArtifact | RenderedGraphArtifact;

export type ArtifactProductionResult =
	| {
			readonly status: 'available';
			readonly artifact: RenderedArtifact;
			/** Present when the request gave unsaved text. */
			readonly unsavedText?: UnsavedTextUse;
	  }
	| { readonly status: 'unavailable' | 'unsupported'; readonly explanation: string };

export interface SourceState {
	readonly size: number;
	readonly mtimeMs: number;
}

/** The state of unsaved text: a hash of the text and of the byte order mark that the overlay file gets. */
export interface UnsavedSourceState {
	readonly unsavedTextHash: string;
}

export type ProductionKey = string & { readonly brand: unique symbol };

/**
 * Identifies raw tool output by what produces it: the producer, the compiled source and its
 * state, and the invocation. Artifact kinds, outputs, and presets that run the same producer
 * with the same invocation share one output. The state of unsaved text is a hash of the text.
 */
export function productionKey(
	request: ArtifactRequest,
	source: SourceState | UnsavedSourceState,
	producer: number,
): ProductionKey {
	const { variant, extraArguments, options, functionFilter } = request;
	return JSON.stringify({
		producer,
		functionFilter,
		source: localFileUriComparisonKey(variant.source),
		state: source,
		toolchain: variant.toolchainProfileId,
		workingDirectory: localFileComparisonKey(variant.workingDirectory),
		arguments: [...variant.arguments, ...extraArguments],
		environment: variant.environment,
		production: options.production,
	}) as ProductionKey;
}

export class CompilationError extends Error {
	/** Present when the request gave unsaved text. */
	readonly unsavedText?: UnsavedTextUse;

	constructor(
		message: string,
		public readonly diagnostics: readonly CompileDiagnostic[] = [],
		public readonly truncated = false,
		options?: ErrorOptions & { readonly unsavedText?: UnsavedTextUse },
	) {
		super(message, options);
		this.name = 'CompilationError';
		if (options?.unsavedText) {
			this.unsavedText = options.unsavedText;
		}
	}
}

export class UnsupportedToolVersionError extends Error {
	constructor(
		message: string,
		public readonly detectedVersion: string,
		public readonly requiredVersion: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = 'UnsupportedToolVersionError';
	}
}

/** Canonical default compilation settings after public configuration normalization. */
export interface DefaultCompilationSettings {
	toolchain: string;
	args: string[];
	env?: Record<string, string>;
	workingDirectory?: string;
}

/**
 * A variant for each source in a folder that no provider describes, such as a configuration of the
 * C/C++ extension. The compilation service makes the variant of a source from it.
 */
export interface FolderVariant {
	/** Unique in its provider. The variant ID of a source adds the source. */
	readonly id: string;
	readonly folder: string;
	readonly toolchainProfileId: string;
	readonly workingDirectory: string;
	/** The arguments for C and Objective-C sources. */
	readonly cArguments: readonly string[];
	/** The arguments for the other sources. */
	readonly cppArguments: readonly string[];
	readonly environment: Readonly<Record<string, string>>;
	readonly displayLabel: string;
	readonly configuration?: string;
}

export interface ProviderSnapshot {
	provider: import('../buildsystems/variant-provider.js').ConfigurationOrigin;
	toolchainProfiles: readonly import('./toolchain-types.js').ToolchainProfile[];
	variants: readonly CompilationVariant[];
	/** Variants for the sources in a folder that no provider describes. */
	folderVariants?: readonly FolderVariant[];
}
