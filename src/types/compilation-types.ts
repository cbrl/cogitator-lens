/**
 * Compilation contracts shared by configuration providers and the toolchain
 * execution layer.
 */

import type { CancellationToken, Uri } from 'vscode';
import type { ParsedAsmResult } from '../parsers/asmresult.interfaces.js';
import type { ArtifactOptions } from './artifact-options.js';

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

export type CompilationOutputMode = 'assembly';

export interface ArtifactRequest {
	variant: CompilationVariant;
	outputMode: CompilationOutputMode;
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

export interface RenderedArtifact {
	result: ParsedAsmResult;
	rawAssembly: string;
	diagnostics: readonly CompileDiagnostic[];
	durationMs: number;
	command: {
		executable: string;
		arguments: readonly string[];
		environmentVariableNames: readonly string[];
		workingDirectory: string;
	};
	truncated: boolean;
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

export interface ReconciliationChange<T> {
	added: readonly T[];
	updated: readonly T[];
	removed: readonly T[];
}
