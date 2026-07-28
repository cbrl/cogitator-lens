/**
 * Compiler configuration at the public settings boundary.
 *
 * These names intentionally match package.json.
 */
export type CompilerKind = 'gcc' | 'clang' | 'apple-clang' | 'msvc' | 'clang-cl';

export interface CompilerSettings {
	name: string;
	type: CompilerKind;
	exe: string;
	args?: string[];
	includes?: string[];
	defines?: string[];
	env?: Record<string, string>;
	includeFlag?: string;
	defineFlag?: string;
	supportsDemangle?: boolean;
	demangler?: string;
	supportsIntel?: boolean;
	supportsLibraryCodeFilter?: boolean;
}

export interface CompilerCapabilities {
	demangle: boolean;
	intelSyntax: boolean;
	libraryCodeFilter: boolean;
}

/** Strongly typed, canonical compiler representation used after configuration loading. */
export interface CompilerProfile {
	id: string;
	displayName: string;
	kind: CompilerKind;
	executable: string;
	defaultArguments: readonly string[];
	includes: readonly string[];
	defines: readonly string[];
	environment: Readonly<Record<string, string>>;
	includeFlag: string;
	defineFlag: string;
	demangler?: string;
	capabilities: Readonly<CompilerCapabilities>;
}

export interface CompileOptions {
	args?: readonly string[];
	defines?: readonly string[];
	includes?: readonly string[];
	env?: Readonly<Record<string, string>>;
	workingDirectory?: string;
}
