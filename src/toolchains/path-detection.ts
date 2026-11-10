import fs from 'node:fs';
import path from 'node:path';
import { execute } from '../exec.js';
import type { ToolchainKind, ToolchainProfile } from '../types/index.js';
import type { ToolchainDefinition } from './toolchain-contracts.js';
import { createToolchainProfile, detectToolchainDefinition } from './toolchain-map.js';
import { localFileComparisonKey } from '../file-identity.js';
import { detectVisualStudioToolchains } from './visual-studio-detection.js';
import { targetFromClangBanner } from './target-architecture.js';
import { environmentValue, versionBanner } from './version-banner.js';

/**
 * A compiler or interpreter that is looked up on PATH. Each PATH directory can hold one, and the
 * names of a candidate are the same tool. So a name whose banner equals the banner of an earlier
 * name is the same tool, such as the `py` launcher and `python.exe`.
 */
export interface PathCandidate {
	readonly names: readonly string[];
	readonly versionArguments: readonly string[];
	/** Rejects an executable whose version banner shows it is something else, such as Apple's `gcc` shim. */
	readonly rejectVersion?: RegExp;
	/** The names of other versions of the tool in a PATH directory, such as `gcc-14`, without `.exe`. */
	readonly versionedNames?: RegExp;
}

/** The candidates in order of preference for languages that several of them compile. */
export function pathCandidates(platform: NodeJS.Platform = process.platform): readonly PathCandidate[] {
	return [
		{
			names: ['gcc'],
			versionArguments: ['--version'],
			rejectVersion: /clang/i,
			versionedNames: /^gcc-\d+(?:\.\d+)*$/,
		},
		{ names: ['clang'], versionArguments: ['--version'], versionedNames: /^clang-\d+(?:\.\d+)*$/ },
		// cl.exe prints its banner to stderr when it runs without arguments, and exits with 0.
		...(platform === 'win32'
			? [
					{ names: ['cl'], versionArguments: [] },
					{ names: ['clang-cl'], versionArguments: ['--version'] },
				]
			: []),
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
		// javac 8 knows only `-version`, and it prints the version to stderr.
		{ names: ['javac'], versionArguments: ['-version'] },
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

/** Finds each executable of a name in the absolute PATH entries, in the order of PATH. */
export async function findExecutablesOnPath(
	name: string,
	environment: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): Promise<string[]> {
	const filename = platform === 'win32' && !path.extname(name) ? `${name}.exe` : name;
	const found: string[] = [];
	for (const directory of pathEntries(environment, platform)) {
		const candidate = path.join(directory, filename);
		if (await isExecutableFile(candidate, platform)) {
			found.push(candidate);
		}
	}
	return found;
}

/** A tool that detection found, before its profile exists. */
export interface DetectedExecutable {
	readonly name: string;
	readonly executable: string;
	/** The profile ID, unique within detection. */
	readonly id: string;
	/** Where detection found it. The variant label shows it. */
	readonly detectedIn: string;
}

/**
 * Finds the compilers and interpreters on PATH, in the Visual Studio installs, and in the rustup
 * toolchains, and returns a profile for every one that works. Each PATH directory can give a
 * profile, and so can each version of a compiler, such as `gcc-14`. A file that two names reach,
 * such as a symlink, gives one profile.
 */
export async function detectPathToolchains(
	environment: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): Promise<ToolchainProfile[]> {
	const candidates = pathCandidates(platform);
	// Each PATH directory is read once for the versioned names of all candidates.
	const listing = candidates.some((candidate) => candidate.versionedNames)
		? listPathDirectories(environment, platform)
		: Promise.resolve([]);
	const [pathGroups, visualStudio] = await Promise.all([
		Promise.all(candidates.map((candidate) => detectCandidate(candidate, environment, platform, listing))),
		detectVisualStudioToolchains(environment, platform),
	]);
	const rustupIndex = candidates.findIndex((candidate) => candidate.names.includes('rustc'));
	const pathRustBanners = new Set(pathGroups[rustupIndex]?.map((profile) => profile.banner));
	const rustup = await detectRustupToolchains(environment, platform, pathRustBanners);
	// The Visual Studio compilers follow the C and C++ compilers on PATH, and the rustup toolchains follow rustc.
	const groups = pathGroups.map((group) => group.map((detected) => detected.profile));
	groups.splice(rustupIndex, 0, visualStudio);
	groups.splice(rustupIndex + 2, 0, rustup);
	const seen = new Set<string>();
	const profiles: ToolchainProfile[] = [];
	for (const profile of groups.flat()) {
		const identity = await realPathKey(profile.executable);
		if (!seen.has(identity)) {
			seen.add(identity);
			profiles.push(profile);
		}
	}
	return profiles;
}

interface DetectedProfile {
	readonly profile: ToolchainProfile;
	readonly banner: string;
}

async function detectCandidate(
	candidate: PathCandidate,
	environment: NodeJS.ProcessEnv,
	platform: NodeJS.Platform,
	listing: Promise<readonly DirectoryListing[]>,
): Promise<DetectedProfile[]> {
	const executables = await candidateExecutables(candidate, environment, platform, listing);
	const probed = await Promise.all(
		executables.map(async (found) => {
			if (!(await canRunWithoutPrompt(found.executable, platform, environment))) {
				return undefined;
			}
			const banner = await versionBanner(found.executable, candidate.versionArguments, environment);
			return banner === undefined || candidate.rejectVersion?.test(banner) ? undefined : { found, banner };
		}),
	);
	const detected: DetectedProfile[] = [];
	const plainBanners = new Set<string>();
	const seen = new Set<string>();
	for (const result of probed) {
		if (!result) {
			continue;
		}
		const { found, banner } = result;
		const plainName = candidate.names.includes(found.name);
		const identity = await realPathKey(found.executable);
		// Two names of one tool, such as `py` and `python`, give the same banner.
		if (seen.has(identity) || (plainName && plainBanners.has(banner))) {
			continue;
		}
		seen.add(identity);
		if (plainName) {
			plainBanners.add(banner);
		}
		const definition = detectToolchainDefinition(found.executable, banner, platform);
		if (!definition) {
			continue;
		}
		const version = versionFromBanner(banner);
		detected.push({
			banner,
			profile: createToolchainProfile(
				definition.kind,
				version ? `${found.name} ${version}` : found.name,
				found.executable,
				// A Clang banner names the default target.
				{ id: found.id, detectedIn: found.detectedIn, target: targetFromClangBanner(banner) },
			),
		});
	}
	return detected;
}

/**
 * The executables of a candidate: each name in each PATH directory, then the versioned names, newest
 * first. The first executable of a name has the name as its ID, so an earlier selection stays.
 */
async function candidateExecutables(
	candidate: PathCandidate,
	environment: NodeJS.ProcessEnv,
	platform: NodeJS.Platform,
	listing: Promise<readonly DirectoryListing[]>,
): Promise<DetectedExecutable[]> {
	const versioned = candidate.versionedNames
		? await versionedExecutables(candidate.versionedNames, await listing, platform)
		: [];
	const byName = [
		...(await Promise.all(
			candidate.names.map(async (name) =>
				(await findExecutablesOnPath(name, environment, platform)).map((executable) => ({ name, executable })),
			),
		)),
		...versioned,
	];
	return byName.flatMap((executables) =>
		executables.map(({ name, executable }, index) => ({
			name,
			executable,
			id: index === 0 ? name : `${name}@${localFileComparisonKey(executable)}`,
			detectedIn: index === 0 ? 'PATH' : path.dirname(executable),
		})),
	);
}

/** The file names in one PATH directory. */
interface DirectoryListing {
	readonly directory: string;
	readonly entries: readonly string[];
}

/** Reads each PATH directory. A directory that cannot be read has no entries. */
function listPathDirectories(environment: NodeJS.ProcessEnv, platform: NodeJS.Platform): Promise<DirectoryListing[]> {
	return Promise.all(
		pathEntries(environment, platform).map(async (directory) => ({
			directory,
			entries: await fs.promises.readdir(directory).catch((): string[] => []),
		})),
	);
}

/** The versioned executables in the PATH directories, grouped by name, newest name first. */
async function versionedExecutables(
	names: RegExp,
	listing: readonly DirectoryListing[],
	platform: NodeJS.Platform,
): Promise<{ readonly name: string; readonly executable: string }[][]> {
	const byName = new Map<string, { readonly name: string; readonly executable: string }[]>();
	for (const { directory, entries } of listing) {
		for (const entry of entries) {
			const name = platform === 'win32' ? entry.replace(/\.exe$/i, '') : entry;
			if ((platform === 'win32' && name === entry) || !names.test(name)) {
				continue;
			}
			const executable = path.join(directory, entry);
			if (await isExecutableFile(executable, platform)) {
				byName.set(name, [...(byName.get(name) ?? []), { name, executable }]);
			}
		}
	}
	return [...byName.entries()]
		.sort(([left], [right]) => right.localeCompare(left, undefined, { numeric: true }))
		.map(([, executables]) => executables);
}

/**
 * The rustc of each rustup toolchain. The rustc on PATH is the rustup proxy, which runs the default
 * toolchain, so a toolchain with the same banner as a rustc on PATH is left out.
 */
async function detectRustupToolchains(
	environment: NodeJS.ProcessEnv,
	platform: NodeJS.Platform,
	pathBanners: ReadonlySet<string>,
): Promise<ToolchainProfile[]> {
	const home = environment.HOME ?? environment.USERPROFILE;
	const rustupHome = environment.RUSTUP_HOME ?? (home ? path.join(home, '.rustup') : undefined);
	if (!rustupHome) {
		return [];
	}
	let toolchains: string[];
	try {
		toolchains = (await fs.promises.readdir(path.join(rustupHome, 'toolchains'))).sort();
	} catch {
		return [];
	}
	const detected = await Promise.all(
		toolchains.map(async (toolchain) => {
			const executable = path.join(
				rustupHome,
				'toolchains',
				toolchain,
				'bin',
				platform === 'win32' ? 'rustc.exe' : 'rustc',
			);
			if (!(await isExecutableFile(executable, platform))) {
				return undefined;
			}
			const banner = await versionBanner(executable, ['--version'], environment);
			if (banner === undefined || pathBanners.has(banner)) {
				return undefined;
			}
			return createToolchainProfile('rust', rustupDisplayName(toolchain, banner), executable, {
				id: `rustc+${toolchain}`,
				detectedIn: 'rustup',
			});
		}),
	);
	return detected.filter((profile): profile is ToolchainProfile => profile !== undefined);
}

/** Names a rustup toolchain without its host triple, such as `rustc 1.99.0 nightly`. */
export function rustupDisplayName(toolchain: string, banner: string): string {
	const channel = toolchain.replace(
		/-(?:x86_64|i686|aarch64|arm64|armv7|riscv64gc|powerpc64le|s390x|loongarch64)-[\w.-]+$/,
		'',
	);
	const version = versionFromBanner(banner);
	return version && !channel.startsWith(version) ? `rustc ${version} ${channel}` : `rustc ${channel}`;
}

/** Identifies a file by its real path, so a symlink and its target are one file. */
async function realPathKey(executable: string): Promise<string> {
	try {
		return localFileComparisonKey(await fs.promises.realpath(executable));
	} catch {
		return localFileComparisonKey(executable);
	}
}

/** A compiler that a configuration names, with its version banner. */
export interface ProbedCompiler {
	readonly kind: ToolchainKind;
	readonly definition: ToolchainDefinition;
	readonly banner: string;
}

/**
 * Runs a compiler that a configuration names, and finds its toolchain from the name and the version
 * banner. A GCC name with a Clang banner is Clang, as `/usr/bin/gcc` is on macOS. A compiler that
 * does not run, or that has no supported name, gives nothing.
 */
export async function probeCompiler(
	executable: string,
	environment: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): Promise<ProbedCompiler | undefined> {
	const byName = detectToolchainDefinition(executable, '', platform);
	if (!byName || !(await canRunWithoutPrompt(executable, platform, environment))) {
		return undefined;
	}
	// cl.exe prints its banner when it runs without arguments.
	const banner = await versionBanner(executable, byName.kind === 'msvc' ? [] : ['--version'], environment);
	if (banner === undefined) {
		return undefined;
	}
	const clangDriver = byName.kind === 'gcc' && /clang version/i.test(banner);
	const detected = detectToolchainDefinition(clangDriver ? 'clang' : executable, banner, platform);
	return detected && { ...detected, banner };
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
	return (environmentValue(environment, 'PATH', platform) ?? '')
		.split(path.delimiter)
		.filter((entry) => entry && path.isAbsolute(entry));
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
