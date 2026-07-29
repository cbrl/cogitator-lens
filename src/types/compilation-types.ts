/**
 * Compilation contracts shared by configuration providers and the compiler
 * execution layer.
 */

import type { CancellationToken, Uri } from 'vscode';
import type { ParsedAsmResult } from '../parsers/asmresult.interfaces.js';
import type {
	CompilerOutputOptions,
	DisplayAssemblyFilters,
} from '../parsers/filters.interfaces.js';

export interface CompilationVariant {
	id: string;
	provider: string;
	project?: string;
	target?: string;
	configuration?: string;
	source: Uri;
	compilerProfileId: string;
	workingDirectory: string;
	arguments: readonly string[];
	includes: readonly string[];
	defines: readonly string[];
	environment: Readonly<Record<string, string>>;
	displayLabel: string;
}

export type CompilationOutputMode = 'assembly';

export interface CompileRequest {
	variant: CompilationVariant;
	outputMode: CompilationOutputMode;
	outputOptions: CompilerOutputOptions;
	filters: DisplayAssemblyFilters;
	cancellationToken: CancellationToken;
}

export interface CompileDiagnostic {
	uri: Uri;
	line: number;
	column: number;
	severity: 'error' | 'warning' | 'information';
	message: string;
}

export interface CompileArtifact {
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
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = 'CompilationError';
	}
}

/** Canonical default compilation settings, matching package.json exactly. */
export interface DefaultCompilationSettings {
	compiler: string;
	defines: string[];
	includes: string[];
	args: string[];
	env?: Record<string, string>;
	workingDirectory?: string;
}

export interface ProviderSnapshot {
	provider: string;
	compilerProfiles: readonly import('./compiler-types.js').CompilerProfile[];
	variants: readonly CompilationVariant[];
}

export interface ReconciliationChange<T> {
	added: readonly T[];
	updated: readonly T[];
	removed: readonly T[];
}
