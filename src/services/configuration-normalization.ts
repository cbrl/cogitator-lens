import path from 'path';
import type {
	ArtifactOptions,
	ArtifactKind,
	DefaultCompilationSettings,
	ToolchainKind,
	ToolchainProfile,
	ToolchainSettings,
} from '../types/index.js';
import { defaultArtifactOptions, immutableArtifactOptions } from '../types/index.js';
import { artifactDefinitions } from '../artifacts/artifact-definitions.js';
import {
	createToolchainProfile,
	supportedToolchainKinds,
} from '../toolchains/toolchain-map.js';

const toolchainKinds = new Set<string>(supportedToolchainKinds);

function isToolchainKind(value: string): value is ToolchainKind {
	return toolchainKinds.has(value);
}

function asString(value: unknown, fallback = ''): string {
	return typeof value === 'string' ? value : fallback;
}

function asStringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === 'string')
		: [];
}

function asStringRecord(value: unknown): Record<string, string> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return {};
	}
	return Object.fromEntries(
		Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
	);
}

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: {};
}

/**
 * A toolchain kind is the one field that must be rejected rather than
 * coerced: an unrecognized kind would otherwise index `undefined` in
 * `createToolchainProfile` instead of failing gracefully at exec time the way
 * every other malformed field does. Returns `undefined` silently for the
 * caller to log with whatever context (e.g. array index) it has.
 */
export function parseToolchainSettings(raw: unknown): ToolchainProfile | undefined {
	const value = asRecord(raw) as Partial<ToolchainSettings>;
	const kind = asString(value.kind);
	if (!isToolchainKind(kind)) {
		return undefined;
	}
	const displayName = asString(value.displayName);
	return createToolchainProfile(kind, displayName, path.normalize(asString(value.executable)), {
		id: displayName,
		defaultArguments: asStringArray(value.defaultArguments),
		environment: asStringRecord(value.environment),
		tools: asStringRecord(value.tools),
	});
}

export function parseDefaultCompilationSettings(raw: unknown): DefaultCompilationSettings {
	const value = asRecord(raw) as Partial<DefaultCompilationSettings>;
	return {
		toolchain: asString(value.toolchain),
		args: asStringArray(value.args),
		env: asStringRecord(value.env),
		workingDirectory: typeof value.workingDirectory === 'string' ? value.workingDirectory : undefined,
	};
}

export function parseArtifactOptions(raw: unknown, kind: ArtifactKind): ArtifactOptions {
	const selected = asRecord(asRecord(raw)[kind]);
	const production: Record<string, boolean> = { ...defaultArtifactOptions.production };
	const display: Record<string, boolean> = { ...defaultArtifactOptions.display };
	for (const descriptor of artifactDefinitions[kind].options) {
		const value = selected[descriptor.id];
		if (typeof value !== 'boolean') {
			continue;
		}
		(descriptor.group === 'production' ? production : display)[descriptor.id] = value;
	}
	return immutableArtifactOptions({ production, display } as unknown as ArtifactOptions);
}
