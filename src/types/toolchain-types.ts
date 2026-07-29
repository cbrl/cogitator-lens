import type { toolchainDefinitions } from '../toolchains/toolchain-map.js';

/** Toolchain configuration at the public settings boundary. */
export type ToolchainKind = keyof typeof toolchainDefinitions;

export type IntelSyntaxSupport = 'selectable' | 'inherent' | 'unsupported';

export interface ToolchainCapabilities {
	readonly demangle: boolean;
	readonly intelSyntax: IntelSyntaxSupport;
	readonly libraryCodeFilter: boolean;
}

export interface ToolchainSettings {
	name: string;
	type: ToolchainKind;
	exe: string;
	args?: string[];
	env?: Record<string, string>;
	tools?: Record<string, string>;
}

/** Strongly typed, canonical toolchain representation used after configuration loading. */
export interface ToolchainProfile {
	id: string;
	displayName: string;
	kind: ToolchainKind;
	executable: string;
	defaultArguments: readonly string[];
	environment: Readonly<Record<string, string>>;
	tools: Readonly<Record<string, string>>;
}

export interface CompileOptions {
	args?: readonly string[];
	env?: Readonly<Record<string, string>>;
	workingDirectory?: string;
	productionOptions: import('./artifact-options.js').ProductionOptions;
}
