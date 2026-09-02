import type { RegisteredToolchainKind } from '../toolchains/toolchain-kinds.js';
import type { InvocationDetails } from './compilation-types.js';

/** Toolchain configuration at the public settings boundary. */
export type ToolchainKind = RegisteredToolchainKind;

export type IntelSyntaxSupport = 'selectable' | 'inherent' | 'unsupported';

/** Canonical invocation metadata for a compiler's secondary executable. */
export interface AuxiliaryTool {
	readonly executable: string;
	readonly inputMode: 'stdin' | 'file-argument';
}

export interface ToolchainSettings {
	displayName: string;
	kind: ToolchainKind;
	executable: string;
	defaultArguments?: string[];
	environment?: Record<string, string>;
	tools?: Record<string, AuxiliaryTool>;
}

/** Strongly typed, canonical toolchain representation used after configuration loading. */
export interface ToolchainProfile {
	id: string;
	displayName: string;
	kind: ToolchainKind;
	executable: string;
	defaultArguments: readonly string[];
	environment: Readonly<Record<string, string>>;
	tools: Readonly<Record<string, AuxiliaryTool>>;
}

export interface CompileOptions {
	args?: readonly string[];
	env?: Readonly<Record<string, string>>;
	workingDirectory?: string;
	productionOptions: import('./artifact-options.js').ProductionOptions;
	/** Internal observer; environment values must never cross this boundary. */
	onInvocation?: (details: InvocationDetails) => void;
}
