import type {
	ArtifactKind,
	ArtifactOptionId,
	ArtifactOptions,
	DefaultCompilationSettings,
	ToolchainSettings,
} from '../types/index.js';
import {
	artifactDefinitions,
	supportedArtifactKinds,
} from '../artifacts/artifact-definitions.js';
import {
	supportedToolchainKinds,
} from '../toolchains/toolchain-map.js';
import { defaultArtifactOptions } from '../types/artifact-options.js';

type JsonSchema = Readonly<Record<string, unknown>>;

interface SettingDescriptor<T> {
	readonly schema: JsonSchema;
	/** Phantom member used only to derive the setting's TypeScript value type. */
	readonly value?: T;
}

function setting<T>(schema: JsonSchema): SettingDescriptor<T> {
	return { schema };
}

const toolchainProperties = {
	name: {
		type: 'string',
		description: 'The name of this toolchain configuration',
	},
	type: {
		type: 'string',
		description: 'The type of toolchain',
		enum: supportedToolchainKinds,
	},
	exe: {
		type: 'string',
		description: 'The path to the toolchain executable',
	},
	args: {
		type: 'array',
		description: 'Arguments provided to the toolchain',
		items: { type: 'string' },
		default: [],
	},
	env: {
		type: 'object',
		description: 'Environment variables defined when using this toolchain',
		additionalProperties: { type: 'string' },
		default: {},
	},
	tools: {
		type: 'object',
		description: 'Named auxiliary tool executables',
		additionalProperties: { type: 'string' },
		default: {},
	},
} as const;

const defaultInvocationProperties = {
	toolchain: {
		type: 'string',
		description: 'Toolchain name matching an entry in coglens.toolchains',
		default: '',
	},
	args: {
		type: 'array',
		description: 'Arguments provided to the selected toolchain',
		items: { type: 'string' },
		default: [],
	},
	env: {
		type: 'object',
		description: 'Environment variables defined for artifact production',
		additionalProperties: { type: 'string' },
		default: {},
	},
	workingDirectory: {
		type: 'string',
		description: 'Working directory used for artifact production',
	},
} as const;

const defaultFlatOptions = {
	...defaultArtifactOptions.production,
	...defaultArtifactOptions.display,
};

const artifactOptionsProperties = Object.fromEntries(
	supportedArtifactKinds.map(kind => [
		kind,
		{
			type: 'object',
			description: `${artifactDefinitions[kind].label} options`,
			additionalProperties: false,
			properties: Object.fromEntries(
				artifactDefinitions[kind].options.map(option => [
					option.id,
					{
						type: 'boolean',
						default: defaultFlatOptions[option.id],
						description: option.description,
					},
				]),
			),
		},
	]),
) as unknown as Readonly<Record<ArtifactKind, JsonSchema>>;

export type ArtifactOptionsSetting =
	Partial<Record<ArtifactKind, Partial<Record<ArtifactOptionId, boolean>>>>;

export const settingDefinitions = {
	compilationDatabases: setting<readonly string[]>({
		type: 'array',
		scope: 'resource',
		default: ['compile_commands.json', 'build/compile_commands.json'],
		description: 'Compilation database paths resolved relative to each workspace folder. Use an empty array to disable compilation database discovery.',
		items: { type: 'string' },
		uniqueItems: true,
	}),
	dimUnusedSourceLines: setting<boolean>({
		type: 'boolean',
		default: true,
		description: 'Dim lines that do not contribute to the rendered artifact',
		scope: 'resource',
	}),
	toolchains: setting<readonly ToolchainSettings[]>({
		type: 'array',
		scope: 'window',
		default: [],
		items: {
			type: 'object',
			title: 'Toolchain configuration',
			description: 'Toolchain configuration parameters',
			default: {},
			required: ['name', 'type', 'exe'],
			additionalProperties: false,
			properties: toolchainProperties,
		},
	}),
	defaultInvocation: setting<DefaultCompilationSettings>({
		type: 'object',
		scope: 'resource',
		title: 'Default Invocation',
		description: 'Default invocation for files with no discovered compilation variant',
		default: {},
		required: ['toolchain'],
		additionalProperties: false,
		properties: defaultInvocationProperties,
	}),
	artifactOptions: setting<ArtifactOptionsSetting>({
		type: 'object',
		scope: 'resource',
		default: {
			assembly: defaultFlatOptions,
		},
		additionalProperties: false,
		properties: artifactOptionsProperties,
	}),
} as const;

export type SettingName = keyof typeof settingDefinitions;
export type SettingValue<Name extends SettingName> =
	(typeof settingDefinitions)[Name] extends SettingDescriptor<infer Value>
		? Value
		: never;

export const toolchainSettingKeys = new Set(Object.keys(toolchainProperties));
export const defaultInvocationKeys = new Set(Object.keys(defaultInvocationProperties));
export const artifactSettingKeys = new Set(supportedArtifactKinds);
export const artifactOptionKeysByKind: Readonly<Record<ArtifactKind, ReadonlySet<string>>> =
	Object.fromEntries(supportedArtifactKinds.map(kind => [
		kind,
		new Set(artifactDefinitions[kind].options.map(option => option.id)),
	])) as unknown as Readonly<Record<ArtifactKind, ReadonlySet<string>>>;

export function manifestConfigurationProperties(): Readonly<Record<string, JsonSchema>> {
	return Object.fromEntries(
		Object.entries(settingDefinitions).map(([name, descriptor]) => [
			`coglens.${name}`,
			descriptor.schema,
		]),
	);
}
