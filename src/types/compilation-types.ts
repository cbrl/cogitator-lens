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

export interface RawArtifact {
	kind: ArtifactKind;
	text: string;
	diagnostics: readonly CompileDiagnostic[];
	durationMs: number;
	command: ArtifactCommand;
	truncated: boolean;
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
	readonly mainSource?: boolean;
}

export interface RenderedArtifactLine {
	readonly text: string;
	readonly opcodes?: readonly string[];
	readonly address?: number;
	readonly disassembly?: string;
	readonly source?: RenderedArtifactLineSource | null;
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
