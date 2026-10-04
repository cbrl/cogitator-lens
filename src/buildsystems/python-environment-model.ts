import path from 'path';
import type { EnvironmentPath, ResolvedEnvironment } from '@vscode/python-extension';
import type { ToolchainProfile } from '../types/index.js';
import { createToolchainProfile } from '../toolchains/toolchain-map.js';
import { localFileComparisonKey } from '../file-identity.js';

export interface PythonEnvironmentProfile {
	readonly environment: ResolvedEnvironment;
	readonly profile: ToolchainProfile;
	readonly aliases: ReadonlySet<string>;
}

export function createPythonEnvironmentProfiles(
	environments: readonly ResolvedEnvironment[],
	platform: NodeJS.Platform = process.platform,
): PythonEnvironmentProfile[] {
	const profiles = new Map<string, PythonEnvironmentProfile>();
	for (const environment of environments) {
		const executable = environment.executable.uri;
		if (!executable || executable.scheme !== 'file') {
			continue;
		}

		const executablePath = path.normalize(executable.fsPath);
		const id = localFileComparisonKey(executablePath);
		const aliases = pythonEnvironmentAliases(environment, platform);
		const existing = profiles.get(id);
		if (existing) {
			profiles.set(id, {
				...existing,
				aliases: new Set([...existing.aliases, ...aliases]),
			});
			continue;
		}

		profiles.set(id, {
			environment,
			profile: createToolchainProfile('python', pythonEnvironmentDisplayName(environment), executablePath, {
				id,
			}),
			aliases,
		});
	}
	return [...profiles.values()];
}

export function matchesPythonEnvironment(
	selection: EnvironmentPath,
	environment: PythonEnvironmentProfile,
	platform: NodeJS.Platform = process.platform,
): boolean {
	return (
		environment.aliases.has(normalizeEnvironmentIdentity(selection.id, platform)) ||
		environment.aliases.has(normalizeEnvironmentIdentity(selection.path, platform)) ||
		(platform === process.platform &&
			(environment.aliases.has(localFileComparisonKey(selection.id)) ||
				environment.aliases.has(localFileComparisonKey(selection.path))))
	);
}

export function pythonEnvironmentDisplayName(environment: ResolvedEnvironment): string {
	const version = environment.version
		? [environment.version.major, environment.version.minor, environment.version.micro].join('.')
		: undefined;
	const environmentName = environment.environment?.name;
	const qualifier =
		environmentName ??
		environment.tools[0] ??
		(environment.environment ? path.basename(environment.environment.folderUri.fsPath) : undefined);
	const title = `Python${version ? ` ${version}` : ''}${qualifier ? ` (${qualifier})` : ''}`;
	return `${title} — ${environment.executable.uri?.fsPath ?? environment.path}`;
}

export function pythonEnvironmentVersion(environment: ResolvedEnvironment): string | undefined {
	return environment.version
		? `${environment.version.major}.${environment.version.minor}.${environment.version.micro}`
		: undefined;
}

function pythonEnvironmentAliases(environment: ResolvedEnvironment, platform: NodeJS.Platform): ReadonlySet<string> {
	const values = [
		environment.id,
		environment.path,
		environment.executable.uri?.fsPath,
		environment.executable.sysPrefix,
		environment.environment?.folderUri.fsPath,
	].filter((value): value is string => Boolean(value));
	return new Set(
		values.flatMap((value) => [
			normalizeEnvironmentIdentity(value, platform),
			...(platform === process.platform ? [localFileComparisonKey(value)] : []),
		]),
	);
}

function normalizeEnvironmentIdentity(value: string, platform: NodeJS.Platform): string {
	const normalized = platform === 'win32' ? path.win32.normalize(value) : path.posix.normalize(value);
	return platform === 'win32' ? normalized.toLowerCase() : normalized;
}
