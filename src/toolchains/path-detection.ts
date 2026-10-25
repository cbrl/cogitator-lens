import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execute } from '../exec.js';
import type { ToolchainProfile } from '../types/index.js';
import { createToolchainProfile, detectToolchainDefinition } from './toolchain-map.js';

/** A compiler or interpreter that is looked up on PATH. Only the first name that runs is used. */
interface PathCandidate {
	readonly names: readonly string[];
	readonly versionArguments: readonly string[];
	/** Rejects an executable whose version banner shows it is something else, such as Apple's `gcc` shim. */
	readonly rejectVersion?: RegExp;
}

/** The candidates in order of preference for languages that several of them compile. */
export function pathCandidates(platform: NodeJS.Platform = process.platform): readonly PathCandidate[] {
	return [
		{ names: ['gcc'], versionArguments: ['--version'], rejectVersion: /clang/i },
		{ names: ['clang'], versionArguments: ['--version'] },
		{ names: ['rustc'], versionArguments: ['--version'] },
		{
			// Windows installs python.exe and the py launcher; python3.exe is usually a Store alias.
			names: platform === 'win32' ? ['python', 'py', 'python3'] : ['python3', 'python'],
			versionArguments: ['--version'],
			rejectVersion: /^Python 2\./m,
		},
		{ names: ['go'], versionArguments: ['version'] },
		{ names: ['zig'], versionArguments: ['version'] },
		{ names: ['dotnet'], versionArguments: ['--version'] },
		{ names: ['nvcc'], versionArguments: ['--version'] },
	];
}

/** Returns the first version number in a version banner. */
export function versionFromBanner(banner: string): string | undefined {
	return /\d+\.\d+(?:\.\d+)?/.exec(banner)?.[0];
}

/** Finds an executable in the absolute PATH entries. Relative entries are skipped because they depend on the working directory. */
export async function findExecutableOnPath(
	name: string,
	environment: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): Promise<string | undefined> {
	const filename = platform === 'win32' && !path.extname(name) ? `${name}.exe` : name;
	for (const directory of pathEntries(environment, platform)) {
		const candidate = path.join(directory, filename);
		if (await isExecutableFile(candidate, platform)) {
			return candidate;
		}
	}
	return undefined;
}

/** Runs each candidate's version command and returns a profile for every one that works. */
export async function detectPathToolchains(
	environment: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): Promise<ToolchainProfile[]> {
	const detected = await Promise.all(
		pathCandidates(platform).map((candidate) => detectCandidate(candidate, environment, platform)),
	);
	return detected.filter((profile): profile is ToolchainProfile => profile !== undefined);
}

async function detectCandidate(
	candidate: PathCandidate,
	environment: NodeJS.ProcessEnv,
	platform: NodeJS.Platform,
): Promise<ToolchainProfile | undefined> {
	for (const name of candidate.names) {
		const executable = await findExecutableOnPath(name, environment, platform);
		if (!executable || !(await canRunWithoutPrompt(executable, platform, environment))) {
			continue;
		}
		const banner = await versionBanner(executable, candidate.versionArguments, environment);
		if (banner === undefined || candidate.rejectVersion?.test(banner)) {
			continue;
		}
		const detected = detectToolchainDefinition(executable, banner, platform);
		if (!detected) {
			continue;
		}
		const version = versionFromBanner(banner);
		return createToolchainProfile(detected.kind, version ? `${name} ${version}` : name, executable, { id: name });
	}
	return undefined;
}

async function versionBanner(
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

/** On macOS these /usr/bin stubs open an installer dialog when they run without the Command Line Tools. */
const appleDeveloperToolStubs = new Set(['clang', 'gcc', 'python3']);

async function canRunWithoutPrompt(
	executable: string,
	platform: NodeJS.Platform,
	environment: NodeJS.ProcessEnv,
): Promise<boolean> {
	if (
		platform !== 'darwin' ||
		path.dirname(executable) !== '/usr/bin' ||
		!appleDeveloperToolStubs.has(path.basename(executable))
	) {
		return true;
	}
	try {
		const result = await execute('/usr/bin/xcode-select', ['-p'], { env: environment, timeoutMs: 5_000 });
		const developerDirectory = result.stdout.trim();
		return result.returnCode === 0 && developerDirectory !== '' && fs.existsSync(developerDirectory);
	} catch {
		return false;
	}
}

function pathEntries(environment: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
	// A copied Windows environment can spell the variable "Path".
	const key =
		platform === 'win32'
			? (Object.keys(environment).find((candidate) => candidate.toUpperCase() === 'PATH') ?? 'PATH')
			: 'PATH';
	return (environment[key] ?? '').split(path.delimiter).filter((entry) => entry && path.isAbsolute(entry));
}

async function isExecutableFile(candidate: string, platform: NodeJS.Platform): Promise<boolean> {
	try {
		const stat = await fs.promises.stat(candidate);
		if (!stat.isFile()) {
			return false;
		}
		if (platform !== 'win32') {
			await fs.promises.access(candidate, fs.constants.X_OK);
		}
		return true;
	} catch {
		return false;
	}
}
