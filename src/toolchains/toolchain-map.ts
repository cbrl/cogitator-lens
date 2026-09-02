import path from 'path';
import type { ToolchainKind, ToolchainProfile } from '../types/index.js';
import { gcc } from './gcc.js';
import { clang, appleClang } from './clang.js';
import { clangCl } from './clang-cl.js';
import { msvc } from './msvc.js';
import { rust } from './rust.js';
import { python } from './python.js';
import { dotnet } from './dotnet.js';
import { go } from './go.js';
import { zig } from './zig.js';
import { nvcc } from './nvcc.js';
import type { ToolchainDefinition, ToolchainDefinitionShape } from './toolchain-contracts.js';
import { supportedToolchainKinds } from './toolchain-kinds.js';

export type {
	ArtifactProducer, ResolvedToolchainArtifactCell, ToolchainArtifactCell, ToolchainArtifactImplementation,
	ToolchainArtifactOutput, ToolchainDefinition, ToolchainDefinitionShape,
} from './toolchain-contracts.js';
export {
	resolveArtifactAvailability, getArtifactOutputChoices, resolveArtifactOutput,
	resolveArtifactOptionAvailability,
} from './toolchain-artifacts.js';

export type ToolCapabilityStatus = 'available' | 'unavailable' | 'unsupported';

export const toolchainDefinitions = {
	gcc,
	'clang-cl': clangCl,
	msvc,
	clang,
	'apple-clang': appleClang,
	rust,
	python,
	dotnet,
	go,
	zig,
	nvcc,
} as const satisfies Record<string, ToolchainDefinitionShape>;

/** Retrieves the complete definition registered for a persisted toolchain kind. */
export function getToolchainDefinition(kind: ToolchainKind): ToolchainDefinition {
	return toolchainDefinitions[kind];
}

/** Detects a definition by executable name, resolving overlapping patterns with \`disambiguate\`. */
export function detectToolchainDefinition(executable: string, versionOutput = '', platform: NodeJS.Platform = process.platform): { kind: ToolchainKind; definition: ToolchainDefinition } | undefined {
	const executableName = path.basename(executable);
	const matches = supportedToolchainKinds.filter((kind) => toolchainDefinitions[kind].executablePattern.test(executableName));
	const kind = matches.find((candidate) => getToolchainDefinition(candidate).disambiguate?.(versionOutput, platform))
		?? matches.find((candidate) => getToolchainDefinition(candidate).disambiguate === undefined);
	return kind ? { kind, definition: toolchainDefinitions[kind] } : undefined;
}

export { supportedToolchainKinds } from './toolchain-kinds.js';

export const supportedLanguageIdentifiers: ReadonlySet<string> = new Set(
	supportedToolchainKinds.flatMap((kind) => toolchainDefinitions[kind].languageIdentifiers),
);

export interface ToolchainProfileOverrides {
	readonly id?: string;
	readonly defaultArguments?: readonly string[];
	readonly environment?: Readonly<Record<string, string>>;
	readonly tools?: Readonly<Record<string, string>>;
}

/** Creates a normalized profile with discovered tools, optionally overridden by persisted settings. */
export function createToolchainProfile(kind: ToolchainKind, displayName: string, executable: string, overrides: ToolchainProfileOverrides = {}): ToolchainProfile {
	const definition = toolchainDefinitions[kind];
	const normalized = path.normalize(executable);
	return {
		id: overrides.id ?? normalizedExecutableLocalId(normalized), displayName, kind, executable: normalized,
		defaultArguments: overrides.defaultArguments ?? [], environment: overrides.environment ?? {},
		tools: Object.freeze({ ...definition.discoverTools(normalized), ...overrides.tools }),
	};
}

/** Produces the platform-stable local identifier used to deduplicate executable paths. */
export function normalizedExecutableLocalId(executable: string): string {
	const normalized = path.resolve(executable);
	return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
