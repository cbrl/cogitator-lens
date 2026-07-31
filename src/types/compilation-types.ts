/**
 * Compilation contracts shared by configuration providers and the toolchain
 * execution layer.
 */

import type { CancellationToken, Uri } from 'vscode';
import type { ArtifactOptions } from './artifact-options.js';
import type { ArtifactKind } from '../artifacts/artifact-definitions.js';

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
	presetId: string;
	extraArguments: readonly string[];
	options: ArtifactOptions;
	cancellationToken: CancellationToken;
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

export interface OptimizationRemarkLineDecoration {
	readonly kind: 'optimization-remark';
	readonly category: OptimizationRemarkCategory;
	readonly text: string;
}

export type RenderedArtifactLineDecoration = OptimizationRemarkLineDecoration;

export interface RenderedArtifactLine {
	readonly text: string;
	readonly opcodes?: readonly string[];
	readonly address?: number;
	readonly disassembly?: string;
	readonly source?: RenderedArtifactLineSource | null;
	/** Visual annotations rendered by the editor without changing document text. */
	readonly decorations?: readonly RenderedArtifactLineDecoration[];
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

export interface RenderedArtifact {
	readonly kind: ArtifactKind;
	readonly lines: readonly RenderedArtifactLine[];
	readonly sourceLocations: readonly ArtifactSourceLocation[];
	readonly links: readonly ArtifactLink[];
	readonly folds: readonly ArtifactFold[];
	readonly symbols: readonly ArtifactSymbol[];
	readonly metrics: Readonly<Record<string, unknown>>;
	readonly raw: RawArtifact;
	/**
	 * Whether output was truncated, either at the tool-output level
	 * (`raw.truncated`) or by the vendored parser's own line-count limit
	 * (which only signals via a `[truncated; too many lines]` marker line,
	 * not a boolean — the upstream parser can't be changed to add one).
	 */
	readonly truncated: boolean;
}

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
