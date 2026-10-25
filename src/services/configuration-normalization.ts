import path from 'path';
import type {
	ArtifactOptions,
	ArtifactKind,
	AuxiliaryTool,
	DefaultCompilationSettings,
	ManualCompilationVariantSettings,
	ToolchainKind,
	ToolchainProfile,
	ToolchainSettings,
} from '../types/index.js';
import { defaultArtifactOptions, immutableArtifactOptions } from '../types/index.js';
import { artifactDefinitions, getArtifactKind } from '../artifacts/core/artifact-definitions.js';
import type { ArtifactPreset } from '../artifacts/ui/presets.js';
import { createToolchainProfile, supportedToolchainKinds } from '../toolchains/toolchain-map.js';
import { expandVariables, noWorkspaceContext, resolvePathSetting, type PathContext } from './path-variables.js';

const toolchainKinds = new Set<string>(supportedToolchainKinds);

function isToolchainKind(value: string): value is ToolchainKind {
	return toolchainKinds.has(value);
}

function asString(value: unknown, fallback = ''): string {
	return typeof value === 'string' ? value : fallback;
}

function asStringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function asStringRecord(value: unknown): Record<string, string> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return {};
	}
	return Object.fromEntries(
		Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
	);
}

/** Parses complete auxiliary-tool invocation metadata from configuration. */
export function parseAuxiliaryTools(
	value: unknown,
	context: PathContext = noWorkspaceContext,
): Record<string, AuxiliaryTool> {
	return Object.fromEntries(
		Object.entries(asRecord(value)).flatMap(([name, raw]) => {
			const tool = asRecord(raw);
			const executable = expandVariables(asString(tool.executable), context);
			const inputMode = tool.inputMode;
			if (!executable || (inputMode !== 'stdin' && inputMode !== 'file-argument')) {
				return [];
			}
			return [[name, Object.freeze({ executable: path.normalize(executable), inputMode })]];
		}),
	);
}

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

/**
 * A toolchain kind is the one field that must be rejected rather than
 * coerced: an unrecognized kind would otherwise index `undefined` in
 * `createToolchainProfile` instead of failing gracefully at exec time the way
 * every other malformed field does. Returns `undefined` silently for the
 * caller to log with whatever context (e.g. array index) it has.
 */
export function parseToolchainSettings(
	raw: unknown,
	context: PathContext = noWorkspaceContext,
): ToolchainProfile | undefined {
	const value = asRecord(raw) as Partial<ToolchainSettings>;
	const kind = asString(value.kind);
	if (!isToolchainKind(kind)) {
		return undefined;
	}
	const displayName = asString(value.displayName);
	// A bare executable name is found on PATH, so a relative executable is not resolved here.
	const executable = path.normalize(expandVariables(asString(value.executable), context));
	return createToolchainProfile(kind, displayName, executable, {
		id: displayName,
		defaultArguments: expandedStrings(value.defaultArguments, context),
		environment: expandedRecord(value.environment, context),
		tools: parseAuxiliaryTools(value.tools, context),
	});
}

export function parseDefaultCompilationSettings(
	raw: unknown,
	context: PathContext = noWorkspaceContext,
): DefaultCompilationSettings {
	const value = asRecord(raw) as Partial<DefaultCompilationSettings>;
	return {
		toolchain: asString(value.toolchain),
		args: expandedStrings(value.args, context),
		env: expandedRecord(value.env, context),
		workingDirectory:
			typeof value.workingDirectory === 'string'
				? resolvePathSetting(value.workingDirectory, context)
				: undefined,
	};
}

/** Parses workspace variants; their paths may use variables or be relative to the workspace folder. */
export function parseManualCompilationVariants(
	raw: unknown,
	context: PathContext = noWorkspaceContext,
): ManualCompilationVariantSettings[] {
	if (!Array.isArray(raw)) {
		return [];
	}
	return raw.flatMap((entry) => {
		const value = asRecord(entry) as Partial<ManualCompilationVariantSettings>;
		const id = asString(value.id);
		const source = resolvePathSetting(asString(value.source), context);
		const displayLabel = asString(value.displayLabel);
		const toolchainProfileId = asString(value.toolchainProfileId);
		const workingDirectory = resolvePathSetting(asString(value.workingDirectory), context);
		if (!id || !source || !displayLabel || !toolchainProfileId || !workingDirectory) {
			return [];
		}
		return [
			{
				id,
				source,
				displayLabel,
				toolchainProfileId,
				workingDirectory,
				arguments: expandedStrings(value.arguments, context),
				environment: expandedRecord(value.environment, context),
				project: optionalString(value.project),
				target: optionalString(value.target),
				configuration: optionalString(value.configuration),
			},
		];
	});
}

export function parseArtifactOptions(raw: unknown, kind: ArtifactKind): ArtifactOptions {
	const selected = asRecord(asRecord(raw)[kind]);
	const production: Record<string, boolean> = { ...defaultArtifactOptions.production };
	const display: Record<string, boolean> = { ...defaultArtifactOptions.display };
	for (const descriptor of artifactDefinitions[kind].options) {
		const value = artifactOptionValue(selected, kind, descriptor.id);
		if (value === undefined) {
			continue;
		}
		(descriptor.group === 'production' ? production : display)[descriptor.id] = value;
	}
	return immutableArtifactOptions({ production, display } as unknown as ArtifactOptions);
}

/** Reads an option, or the inverse of the earlier option it replaced when only that one is set. */
export function artifactOptionValue(
	options: Readonly<Record<string, unknown>>,
	kind: ArtifactKind,
	id: string,
): boolean | undefined {
	const value = options[id];
	if (typeof value === 'boolean') {
		return value;
	}
	const former = formerOptionId(kind, id);
	const earlier = former === undefined ? undefined : options[former];
	return typeof earlier === 'boolean' ? !earlier : undefined;
}

/** The earlier option ID that an option of an artifact kind replaced, if any. */
export function formerOptionId(kind: ArtifactKind, id: string): string | undefined {
	return formerOptionIds(kind, id)[0];
}

/** The earlier option IDs that an option of an artifact kind replaced. */
export function formerOptionIds(kind: ArtifactKind, id: string): string[] {
	return Object.entries(artifactDefinitions[kind].formerOptions ?? {}).flatMap(([former, current]) =>
		current === id ? [former] : [],
	);
}

export function parseArtifactPresets(raw: unknown, context: PathContext = noWorkspaceContext): ArtifactPreset[] {
	return Object.entries(asRecord(raw)).flatMap(([id, rawPreset]) => {
		const preset = asRecord(rawPreset);
		const configuredKind = asString(preset.artifactKind);
		const artifactKind = getArtifactKind(configuredKind);
		if (!artifactKind) {
			return [];
		}
		const rawProductionOptions = asRecord(preset.productionOptions);
		const productionOptions = Object.fromEntries(
			Object.keys(defaultArtifactOptions.production).flatMap((key) =>
				typeof rawProductionOptions[key] === 'boolean' ? [[key, rawProductionOptions[key]]] : [],
			),
		);
		return [
			{
				id,
				artifactKind,
				extraArguments: expandedStrings(preset.extraArguments, context),
				productionOptions,
			},
		];
	});
}

function expandedStrings(value: unknown, context: PathContext): string[] {
	return asStringArray(value).map((item) => expandVariables(item, context));
}

function expandedRecord(value: unknown, context: PathContext): Record<string, string> {
	return Object.fromEntries(
		Object.entries(asStringRecord(value)).map(([key, item]) => [key, expandVariables(item, context)]),
	);
}

function optionalString(value: unknown): string | undefined {
	return typeof value === 'string' && value ? value : undefined;
}
