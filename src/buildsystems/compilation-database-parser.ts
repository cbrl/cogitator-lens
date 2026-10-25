import path from 'path';
import { createToolchainProfile, detectToolchainDefinition } from '../toolchains/toolchain-map.js';
import { tokenizeCommandLine } from '../tokenize.js';
import type { ToolchainProfile } from '../types/index.js';
import { absoluteLocalPath, localFileComparisonKey } from '../file-identity.js';
import { isRecord } from '../common.js';

export const compilationDatabaseProviderId = 'compilation-database';

export interface ParsedCompilationDatabaseEntry {
	readonly entryIndex: number;
	readonly sourceFile: string;
	readonly workingDirectory: string;
	readonly arguments: readonly string[];
	readonly output?: string;
	readonly toolchainProfile: ToolchainProfile;
}

type ReportMalformedEntry = (message: string) => void;

export function parseCompilationDatabase(
	contents: string,
	databasePath: string,
	platform: NodeJS.Platform = process.platform,
	reportMalformedEntry: ReportMalformedEntry = () => undefined,
): ParsedCompilationDatabaseEntry[] {
	let value: unknown;
	try {
		value = JSON.parse(contents);
	} catch (error) {
		reportMalformedEntry(`invalid JSON: ${String(error)}`);
		return [];
	}
	if (!Array.isArray(value)) {
		reportMalformedEntry('the top-level value must be an array');
		return [];
	}

	const parsed: ParsedCompilationDatabaseEntry[] = [];
	// Entries repeat the same compilers and directories, so their identities are resolved once.
	const caches: ParseCaches = { identities: new PathIdentities(), profiles: new Map() };
	value.forEach((entry, entryIndex) => {
		const result = parseEntry(entry, entryIndex, databasePath, platform, reportMalformedEntry, caches);
		if (result) {
			parsed.push(result);
		}
	});
	return parsed;
}

function parseEntry(
	value: unknown,
	entryIndex: number,
	databasePath: string,
	platform: NodeJS.Platform,
	reportMalformedEntry: ReportMalformedEntry,
	caches: ParseCaches,
): ParsedCompilationDatabaseEntry | undefined {
	const fail = (message: string): undefined => {
		reportMalformedEntry(`entry ${entryIndex}: ${message}`);
		return undefined;
	};
	if (!isRecord(value)) {
		return fail('must be an object');
	}
	if (typeof value.directory !== 'string' || !value.directory.trim()) {
		return fail('"directory" must be a non-empty string');
	}
	if (typeof value.file !== 'string' || !value.file.trim()) {
		return fail('"file" must be a non-empty string');
	}
	if (value.output !== undefined && typeof value.output !== 'string') {
		return fail('"output" must be a string when present');
	}

	let commandArguments: string[];
	if (value.arguments !== undefined) {
		if (
			!Array.isArray(value.arguments) ||
			value.arguments.length === 0 ||
			value.arguments.some((argument) => typeof argument !== 'string')
		) {
			return fail('"arguments" must be a non-empty array of strings');
		}
		commandArguments = [...value.arguments] as string[];
	} else {
		if (typeof value.command !== 'string' || !value.command.trim()) {
			return fail('must contain "arguments" or a non-empty "command"');
		}
		try {
			commandArguments = tokenizeCommandLine(value.command, platform === 'win32' ? 'windows' : 'posix');
		} catch (error) {
			return fail(`could not tokenize "command": ${String(error)}`);
		}
		if (commandArguments.length === 0) {
			return fail('"command" did not contain a compiler executable');
		}
	}

	const workingDirectory = path.isAbsolute(value.directory)
		? path.normalize(value.directory)
		: path.resolve(path.dirname(databasePath), value.directory);
	const sourceFile = path.isAbsolute(value.file)
		? path.normalize(value.file)
		: path.resolve(workingDirectory, value.file);
	const executable = resolveExecutable(commandArguments[0], workingDirectory);
	const toolchainProfile = compilerProfile(executable, platform, caches);
	if (!toolchainProfile) {
		return fail(`unsupported compiler executable "${commandArguments[0]}"`);
	}

	return {
		entryIndex,
		sourceFile,
		workingDirectory,
		arguments: removeSourceArgument(commandArguments.slice(1), sourceFile, workingDirectory, {
			identities: caches.identities,
			platform,
		}),
		output: value.output,
		toolchainProfile,
	};
}

interface ParseCaches {
	readonly identities: PathIdentities;
	/** Profiles by executable spelling; `null` for an unsupported compiler. */
	readonly profiles: Map<string, ToolchainProfile | null>;
}

/** Creates one profile per compiler, since discovering its tools reads the file system. */
function compilerProfile(
	executable: string,
	platform: NodeJS.Platform,
	caches: ParseCaches,
): ToolchainProfile | undefined {
	let profile = caches.profiles.get(executable);
	if (profile === undefined) {
		const kind = detectToolchainDefinition(executable, '', platform)?.kind;
		profile = kind
			? createToolchainProfile(kind, `${path.basename(executable)} — ${executable}`, executable, {
					id: caches.identities.key(executable),
				})
			: null;
		caches.profiles.set(executable, profile);
	}
	return profile ?? undefined;
}

/** Physical path identities, resolved once per spelling for the lifetime of one parse. */
export class PathIdentities {
	private readonly keys = new Map<string, string>();

	key(absolutePath: string): string {
		let key = this.keys.get(absolutePath);
		if (key === undefined) {
			key = localFileComparisonKey(absolutePath);
			this.keys.set(absolutePath, key);
		}
		return key;
	}
}

/**
 * Removes the arguments that name the source file. Option-like arguments cannot name it, and a
 * file with another name is not resolved through symlinks, so most arguments cost no file
 * system access.
 */
export function removeSourceArgument(
	args: readonly string[],
	sourceFile: string,
	workingDirectory?: string,
	{ identities = new PathIdentities(), platform = process.platform }: RemoveSourceOptions = {},
): string[] {
	const sourcePath = absoluteLocalPath(sourceFile);
	const sourceName = comparableName(path.basename(sourcePath), platform);
	return args.filter((argument) => {
		if (!argument || argument.startsWith('-') || (platform === 'win32' && argument.startsWith('/'))) {
			return true;
		}
		const candidate = absoluteLocalPath(argument, workingDirectory);
		if (comparableName(candidate, platform) === comparableName(sourcePath, platform)) {
			return false;
		}
		return (
			comparableName(path.basename(candidate), platform) !== sourceName ||
			identities.key(candidate) !== identities.key(sourcePath)
		);
	});
}

interface RemoveSourceOptions {
	readonly identities?: PathIdentities;
	readonly platform?: NodeJS.Platform;
}

function comparableName(name: string, platform: NodeJS.Platform): string {
	return platform === 'win32' ? name.toLowerCase() : name;
}

function resolveExecutable(executable: string, workingDirectory: string): string {
	if (path.isAbsolute(executable)) {
		return path.normalize(executable);
	}
	return /[\\/]/.test(executable) ? path.resolve(workingDirectory, executable) : executable;
}
