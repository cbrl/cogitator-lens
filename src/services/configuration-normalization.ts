import path from 'path';
import type {
	ArtifactOptions,
	ArtifactKind,
	DefaultCompilationSettings,
	ToolchainKind,
	ToolchainProfile,
	ToolchainSettings,
} from '../types/index.js';
import {
	defaultArtifactOptions,
	immutableArtifactOptions,
} from '../types/index.js';
import {
	createToolchainProfile,
	supportedToolchainKinds,
} from '../toolchains/toolchain-map.js';
import {
	artifactOptionKeysByKind,
	artifactSettingKeys,
	defaultInvocationKeys,
	toolchainSettingKeys,
} from './settings-descriptors.js';

export type Normalized<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly errors: readonly [string, ...string[]] };

const toolchainKinds = new Set<ToolchainKind>(supportedToolchainKinds);
function failure<T>(errors: string[]): Normalized<T> {
	if (errors.length === 0) {
		throw new Error('A failed normalization must contain at least one error');
	}
	return { ok: false, errors: errors as [string, ...string[]] };
}

function stringArray(value: unknown, field: string, errors: string[]): string[] {
	if (value === undefined) {
		return [];
	}
	if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
		errors.push(`${field} must be an array of strings`);
		return [];
	}
	return [...value];
}

function stringRecord(value: unknown, field: string, errors: string[]): Record<string, string> {
	if (value === undefined) {
		return {};
	}
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		errors.push(`${field} must be an object containing string values`);
		return {};
	}

	const result: Record<string, string> = {};
	for (const [key, item] of Object.entries(value)) {
		if (typeof item !== 'string') {
			errors.push(`${field}.${key} must be a string`);
		} else {
			result[key] = item;
		}
	}
	return result;
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, errors: string[]): void {
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) {
			errors.push(`unknown setting: ${key}`);
		}
	}
}

export function normalizeToolchainSettings(raw: unknown): Normalized<ToolchainProfile> {
	const errors: string[] = [];
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		return failure(['toolchain must be an object']);
	}

	const value = raw as Record<string, unknown>;
	rejectUnknownKeys(value, toolchainSettingKeys, errors);

	const name = typeof value.name === 'string' ? value.name.trim() : '';
	const executable = typeof value.exe === 'string' ? value.exe.trim() : '';
	const kind = value.type;
	if (!name) {
		errors.push('name must be a non-empty string');
	}
	if (!executable) {
		errors.push('exe must be a non-empty string');
	}
	if (typeof kind !== 'string' || !toolchainKinds.has(kind as ToolchainKind)) {
		errors.push(`type must be one of: ${[...toolchainKinds].join(', ')}`);
	}

	const args = stringArray(value.args, 'args', errors);
	const environment = stringRecord(value.env, 'env', errors);
	const tools = stringRecord(value.tools, 'tools', errors);
	if (errors.length > 0) {
		return failure(errors);
	}

	const toolchainKind = kind as ToolchainKind;
	return {
		ok: true,
		value: createToolchainProfile(toolchainKind, name, path.normalize(executable), {
			id: name,
			defaultArguments: args,
			environment,
			tools,
		}),
	};
}

export function toolchainProfileToSettings(profile: ToolchainProfile): ToolchainSettings {
	return {
		name: profile.displayName,
		type: profile.kind,
		exe: profile.executable,
		args: [...profile.defaultArguments],
		env: { ...profile.environment },
		tools: { ...profile.tools },
	};
}

export function normalizeDefaultCompilationSettings(raw: unknown): Normalized<DefaultCompilationSettings> {
	const errors: string[] = [];
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		return failure(['defaultInvocation must be an object']);
	}

	const value = raw as Record<string, unknown>;
	rejectUnknownKeys(value, defaultInvocationKeys, errors);
	const toolchain = typeof value.toolchain === 'string' ? value.toolchain.trim() : '';
	if (!toolchain) {
		errors.push('toolchain must be a non-empty string');
	}
	const args = stringArray(value.args, 'args', errors);
	const environment = stringRecord(value.env, 'env', errors);
	if (value.workingDirectory !== undefined && typeof value.workingDirectory !== 'string') {
		errors.push('workingDirectory must be a string');
	}
	if (errors.length > 0) {
		return failure(errors);
	}

	return {
		ok: true,
		value: {
			toolchain,
			args,
			env: environment,
			workingDirectory: value.workingDirectory as string | undefined,
		},
	};
}

export function normalizeArtifactOptions(
	raw: unknown,
	kind: ArtifactKind,
): Normalized<ArtifactOptions> {
	const errors: string[] = [];
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		return failure(['artifactOptions must be an object keyed by artifact kind']);
	}
	const settings = raw as Record<string, unknown>;
	rejectUnknownKeys(settings, artifactSettingKeys, errors);
	const selected = settings[kind] ?? {};
	if (typeof selected !== 'object' || selected === null || Array.isArray(selected)) {
		errors.push(`${kind} must be an object`);
	}
	const value = typeof selected === 'object' && selected !== null && !Array.isArray(selected)
		? selected as Record<string, unknown>
		: {};
	rejectUnknownKeys(value, artifactOptionKeysByKind[kind], errors);
	for (const [name, option] of Object.entries(value)) {
		if (typeof option !== 'boolean') {
			errors.push(`${name} must be a boolean`);
		}
	}
	if (errors.length > 0) {
		return failure(errors);
	}

	return {
		ok: true,
		value: immutableArtifactOptions({
			production: {
				...defaultArtifactOptions.production,
				intel: value.intel as boolean | undefined ?? defaultArtifactOptions.production.intel,
				demangle: value.demangle as boolean | undefined ?? defaultArtifactOptions.production.demangle,
			},
			display: {
				...defaultArtifactOptions.display,
				labels: value.labels as boolean | undefined ?? defaultArtifactOptions.display.labels,
				libraryCode: value.libraryCode as boolean | undefined ?? defaultArtifactOptions.display.libraryCode,
				directives: value.directives as boolean | undefined ?? defaultArtifactOptions.display.directives,
				commentOnly: value.commentOnly as boolean | undefined ?? defaultArtifactOptions.display.commentOnly,
				trim: value.trim as boolean | undefined ?? defaultArtifactOptions.display.trim,
				dontMaskFilenames: value.dontMaskFilenames as boolean | undefined
					?? defaultArtifactOptions.display.dontMaskFilenames,
			},
		}),
	};
}
