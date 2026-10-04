import path from 'path';
import { detectToolchainDefinition } from '../toolchains/toolchain-map.js';
import { createToolchainProfile } from '../toolchains/toolchain-map.js';
import { tokenizeCommandLine } from '../tokenize.js';
import type { ToolchainProfile } from '../types/index.js';
import { localFileComparisonKey, sameLocalFile } from '../local-file-identity.js';
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
	value.forEach((entry, entryIndex) => {
		const result = parseEntry(entry, entryIndex, databasePath, platform, reportMalformedEntry);
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
	const compilerKind = detectToolchainDefinition(executable, '', platform)?.kind;
	if (!compilerKind) {
		return fail(`unsupported compiler executable "${commandArguments[0]}"`);
	}

	const executableName = path.basename(executable);
	const profileId = localFileComparisonKey(executable);
	const toolchainProfile = createToolchainProfile(compilerKind, `${executableName} — ${executable}`, executable, {
		id: profileId,
	});

	return {
		entryIndex,
		sourceFile,
		workingDirectory,
		arguments: removeSourceArgument(commandArguments.slice(1), sourceFile, workingDirectory),
		output: value.output,
		toolchainProfile,
	};
}

export function removeSourceArgument(args: readonly string[], sourceFile: string, workingDirectory?: string): string[] {
	return args.filter((argument) => !sameLocalFile(argument, sourceFile, workingDirectory));
}

function resolveExecutable(executable: string, workingDirectory: string): string {
	if (path.isAbsolute(executable)) {
		return path.normalize(executable);
	}
	return /[\\/]/.test(executable) ? path.resolve(workingDirectory, executable) : executable;
}
