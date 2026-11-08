import os from 'node:os';
import { execute } from '../exec.js';

/**
 * Runs a tool with its version arguments and returns its output. A tool that fails or prints
 * nothing gives no banner.
 */
export async function versionBanner(
	executable: string,
	args: readonly string[],
	environment: NodeJS.ProcessEnv,
): Promise<string | undefined> {
	try {
		// The temporary directory has no go.mod or global.json that could switch toolchains.
		const result = await execute(executable, args, {
			cwd: os.tmpdir(),
			env: environment,
			timeoutMs: 10_000,
			maxOutputBytes: 64 * 1024,
		});
		const banner = `${result.stdout}\n${result.stderr}`.trim();
		return result.returnCode === 0 && banner ? banner : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Reads an environment variable. On Windows, the name can have any case, so a copied environment
 * can spell PATH as "Path".
 */
export function environmentValue(
	environment: NodeJS.ProcessEnv,
	name: string,
	platform: NodeJS.Platform = process.platform,
): string | undefined {
	const key =
		platform === 'win32'
			? Object.keys(environment).find((candidate) => candidate.toUpperCase() === name.toUpperCase())
			: name;
	return key === undefined ? undefined : environment[key];
}
