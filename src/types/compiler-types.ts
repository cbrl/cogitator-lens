/**
 * Compiler type definitions and related types
 */

export type CompilerType = 'gcc' | 'msvc' | 'clang-cl';

export type CompilerInfo = {
	name: string;
	type: string;
	exe: string;

	args?: string[];

	includeFlag: string;
	includePaths?: string[];

	defineFlag: string;
	defines?: string[];

	envVars?: Record<string, string>;

	supportsDemangle?: boolean;
	demangler?: string;

	supportsIntel?: boolean;
	supportsLibraryCodeFilter?: boolean;
};

export type CompileOptions = {
	args?: string[];
	defines?: string[];
	includes?: string[];
	env?: Record<string, string>;
};
