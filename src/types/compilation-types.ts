/**
 * Compilation contracts shared by configuration providers and the toolchain
 * execution layer.
 */

import type { CancellationToken, Uri } from 'vscode';
import type { ArtifactOptions } from './artifact-options.js';
import type { ArtifactKind } from '../artifacts/core/artifact-definitions.js';

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
}

export interface CompileDiagnostic {
	uri: Uri;
	line: number;
	column: number;
	severity: 'error' | 'warning' | 'information';
	message: string;
}

export interface ArtifactCommand {
	executable: string;
	arguments: readonly string[];
	environmentVariableNames: readonly string[];
	workingDirectory: string;
}

/** Sanitized invocation metadata suitable for presentation layers. */
export interface InvocationDetails {
	readonly executable: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly environmentVariableNames: readonly string[];
}

/** Remove execution-only values before invocation metadata reaches a view. */
export function invocationDetails(command: ArtifactCommand): InvocationDetails {
	return Object.freeze({
		executable: command.executable,
		args: Object.freeze([...command.arguments]),
		cwd: command.workingDirectory,
		environmentVariableNames: Object.freeze(
			[...command.environmentVariableNames].sort(),
		),
	});
}

export interface ArtifactInputState {
	readonly uri: string;
	readonly size: number;
	readonly mtimeMs: number;
}

export interface RawArtifact {
	kind: ArtifactKind;
	text: string;
	diagnostics: readonly CompileDiagnostic[];
	durationMs: number;
	/** Unix epoch milliseconds when tool output and dependency discovery completed. */
	generatedAt: number;
	command: ArtifactCommand;
	truncated: boolean;
	readonly inputs: readonly ArtifactInputState[];
	readonly dependencyCoverage: 'complete' | 'source-only';
}

export interface ArtifactSourceLocation {
	readonly line: number;
	readonly uri: string;
	readonly sourceLine: number;
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

export type OptimizationRemarkCategory =
	| 'passed'
	| 'missed'
	| 'analysis';

export interface OptimizationRemarkLineAnnotation {
	readonly kind: 'optimization-remark';
	readonly category: OptimizationRemarkCategory;
	readonly message: string;
}

export type StackUsageQualifier =
	| 'static'
	| 'dynamic'
	| 'dynamic-bounded'
	| 'vm';

export interface StackUsageLineAnnotation {
	readonly kind: 'stack-usage';
	readonly functionName: string;
	readonly value: number;
	readonly unit: 'bytes' | 'vm-slots';
	readonly qualifier: StackUsageQualifier;
}

export type ArtifactLineAnnotation =
	| OptimizationRemarkLineAnnotation
	| StackUsageLineAnnotation;

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

export type ControlFlowTerminal =
	| 'return'
	| 'throw'
	| 'resume'
	| 'unreachable';

export type ControlFlowEdgeKind =
	| 'unconditional'
	| 'true'
	| 'false'
	| 'fallthrough'
	| 'return'
	| 'exception';

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
	readonly truncated: boolean;
	/** Whether the tool output limit, rather than a renderer limit, was reached. */
	readonly toolOutputTruncated: boolean;
}

export interface RenderedTextArtifact extends RenderedArtifactBase {
	readonly presentation: 'text';
	readonly lines: readonly RenderedArtifactLine[];
	readonly sourceLocations: readonly ArtifactSourceLocation[];
	readonly links: readonly ArtifactLink[];
	readonly folds: readonly ArtifactFold[];
	readonly symbols: readonly ArtifactSymbol[];
	/** The bounded compiler output before text rendering or filtering. */
	readonly raw: string;
	/** Readable alias for `raw` retained for text-renderer call sites. */
	readonly text: string;
}

export interface RenderedGraphArtifact extends RenderedArtifactBase {
	readonly presentation: 'graph';
	readonly graphs: readonly ControlFlowGraph[];
}

export type RenderedArtifact = RenderedTextArtifact | RenderedGraphArtifact;

export type ArtifactProductionResult =
	| { readonly status: 'available'; readonly artifact: RenderedArtifact }
	| { readonly status: 'unavailable' | 'unsupported'; readonly explanation: string };

export interface SourceState {
	readonly size: number;
	readonly mtimeMs: number;
}

export type ProductionKey = string & { readonly brand: unique symbol };

export function productionKey(
	request: ArtifactRequest,
	source: SourceState,
): ProductionKey {
	const {
		cancellationToken: _cancellationToken,
		onInvocation: _onInvocation,
		options,
		...productionInputs
	} = request;
	return JSON.stringify({
		...productionInputs,
		options: { production: options.production },
		source,
	}) as ProductionKey;
}

export class CompilationError extends Error {
	constructor(
		message: string,
		public readonly diagnostics: readonly CompileDiagnostic[] = [],
		public readonly truncated = false,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = 'CompilationError';
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

export interface ProviderSnapshot {
	provider: import('../buildsystems/variant-provider.js').ConfigurationOrigin;
	toolchainProfiles: readonly import('./toolchain-types.js').ToolchainProfile[];
	variants: readonly CompilationVariant[];
}
