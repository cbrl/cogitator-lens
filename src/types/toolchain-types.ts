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
	target?: string;
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
	/**
	 * Where detection found the toolchain, such as `PATH`, a PATH directory, a Visual Studio
	 * install, or `rustup`. The label of a detected variant shows it.
	 */
	readonly detectedIn?: string;
	/** The target triple, such as `aarch64-linux-gnu`. Without it, the compiler reports its target. */
	readonly target?: string;
}

export interface CompileOptions {
	args?: readonly string[];
	env?: Readonly<Record<string, string>>;
	workingDirectory?: string;
	productionOptions: import('./artifact-options.js').ProductionOptions;
	/** Internal observer; environment values must never cross this boundary. */
	onInvocation?: (details: InvocationDetails) => void;
	/** The unsaved text that the compile reads in place of the saved source. */
	sourceOverlay?: SourceOverlay;
	/**
	 * The function whose output the compile prints, for an output that the compiler can limit to
	 * one function. It is the name in the compiler output, such as a mangled name.
	 */
	functionFilter?: string;
}

/** The unsaved text of a source, which a compile reads from a file in its temporary directory. */
export interface SourceOverlay {
	readonly text: string;
	/** Whether the saved file starts with a UTF-8 byte order mark. The overlay file copies it. */
	readonly byteOrderMark: boolean;
}
