import os from 'node:os';
import path from 'node:path';
import { isRecord } from '../common.js';
import { tokenizeCommandLine } from '../tokenize.js';

/**
 * The compile settings of one configuration in `.vscode/c_cpp_properties.json`, with its variables
 * expanded. A property that the configuration leaves out has the value of its `C_Cpp.default`
 * setting, as in the C/C++ extension.
 */
export interface CppToolsConfiguration {
	readonly name: string;
	/** The compiler and the arguments that follow it in `compilerPath`. */
	readonly compilerPath?: string;
	readonly compilerArgs: readonly string[];
	readonly includePath: readonly string[];
	readonly defines: readonly string[];
	readonly forcedInclude: readonly string[];
	readonly macFrameworkPath: readonly string[];
	readonly cStandard?: string;
	readonly cppStandard?: string;
	/** The compilation databases of the configuration, as absolute paths. */
	readonly compileCommands: readonly string[];
}

/** The `C_Cpp.default` settings that a configuration can use. */
export interface CppToolsDefaults {
	readonly compilerPath?: string;
	readonly compilerArgs?: readonly string[];
	readonly includePath?: readonly string[];
	readonly defines?: readonly string[];
	readonly forcedInclude?: readonly string[];
	readonly macFrameworkPath?: readonly string[];
	readonly cStandard?: string;
	readonly cppStandard?: string;
	readonly compileCommands?: string | readonly string[];
}

/** What the variables of a configuration refer to. */
export interface CppToolsContext {
	readonly workspaceFolder: string;
	readonly environment: Readonly<Record<string, string | undefined>>;
	readonly defaults: CppToolsDefaults;
	readonly userHome?: string;
}

/** The argument spelling of a compiler: GCC and Clang, or cl.exe and clang-cl. */
export type ArgumentDialect = 'gnu' | 'msvc';

const listProperties = ['compilerArgs', 'includePath', 'defines', 'forcedInclude', 'macFrameworkPath'] as const;

/**
 * Reads the configurations of a `c_cpp_properties.json` file. The file can hold comments and
 * trailing commas. A file that is not valid gives no configurations.
 */
export function parseCppToolsProperties(text: string, context: CppToolsContext): CppToolsConfiguration[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(withoutJsonComments(text));
	} catch {
		return [];
	}
	if (!isRecord(parsed) || !Array.isArray(parsed.configurations)) {
		return [];
	}
	const variables = customVariables(parsed.env);
	return parsed.configurations.flatMap((entry, index): CppToolsConfiguration[] =>
		isRecord(entry) ? [resolveConfiguration(entry, index, variables, context)] : [],
	);
}

/** The configuration name that the C/C++ extension selects first on each platform. */
const platformConfigurationNames: Partial<Record<NodeJS.Platform, string>> = {
	win32: 'Win32',
	linux: 'Linux',
	darwin: 'Mac',
};

/**
 * Orders the configurations for their variants and gives each one a key. The configuration that
 * the C/C++ extension selects on the platform comes first, such as "Win32" on Windows. The key is
 * the name, with a number for a repeated name. Thus the key stays when a configuration moves.
 */
export function orderedConfigurations(
	configurations: readonly CppToolsConfiguration[],
	platform: NodeJS.Platform = process.platform,
): { readonly key: string; readonly configuration: CppToolsConfiguration }[] {
	const counts = new Map<string, number>();
	const keyed = configurations.map((configuration) => {
		const count = (counts.get(configuration.name) ?? 0) + 1;
		counts.set(configuration.name, count);
		return { key: count > 1 ? `${configuration.name}#${count}` : configuration.name, configuration };
	});
	const name = platformConfigurationNames[platform];
	return [
		...keyed.filter((entry) => entry.configuration.name === name),
		...keyed.filter((entry) => entry.configuration.name !== name),
	];
}

/** A configuration made from the `C_Cpp.default` settings alone, for a folder without the file. */
export function defaultConfiguration(context: CppToolsContext): CppToolsConfiguration | undefined {
	const { compilerPath, compileCommands } = context.defaults;
	return compilerPath || compileCommands
		? resolveConfiguration({ name: 'C_Cpp.default' }, 0, new Map(), context)
		: undefined;
}

function resolveConfiguration(
	entry: Record<string, unknown>,
	index: number,
	variables: ReadonlyMap<string, string | readonly string[]>,
	context: CppToolsContext,
): CppToolsConfiguration {
	const expand = (value: string): string => expandVariables(value, variables, context);
	const list = (property: (typeof listProperties)[number]): string[] => {
		const own = stringList(entry[property]);
		const defaults = context.defaults[property] ?? [];
		return (own ?? defaults).flatMap((value) => {
			if (value === '${default}') {
				return defaults.map(expand);
			}
			const variable = /^\$\{([^}:.]+)\}$/.exec(value)?.[1];
			const spliced = variable === undefined ? undefined : variables.get(variable);
			return Array.isArray(spliced) ? spliced.map(expand) : [expand(value)];
		});
	};
	const single = (property: 'compilerPath' | 'cStandard' | 'cppStandard'): string | undefined => {
		const own = typeof entry[property] === 'string' ? (entry[property] as string) : undefined;
		const value = own === '${default}' || own === undefined ? context.defaults[property] : own;
		return value === undefined ? undefined : expand(value);
	};
	const ownDatabases =
		typeof entry.compileCommands === 'string' ? [entry.compileCommands] : stringList(entry.compileCommands);
	const defaultDatabases = context.defaults.compileCommands;
	const databases =
		ownDatabases ?? (typeof defaultDatabases === 'string' ? [defaultDatabases] : [...(defaultDatabases ?? [])]);
	return {
		name: typeof entry.name === 'string' && entry.name ? entry.name : `Configuration ${index + 1}`,
		compilerPath: single('compilerPath'),
		compilerArgs: list('compilerArgs'),
		includePath: list('includePath'),
		defines: list('defines'),
		forcedInclude: list('forcedInclude'),
		macFrameworkPath: list('macFrameworkPath'),
		cStandard: single('cStandard'),
		cppStandard: single('cppStandard'),
		compileCommands: databases
			.map(expand)
			.filter(Boolean)
			.map((database) => path.resolve(context.workspaceFolder, database)),
	};
}

/**
 * Splits `compilerPath` into the compiler and its arguments. A path to a file is the compiler
 * alone, also when it holds spaces. Otherwise the value is a command line, such as
 * `"C:/MinGW/bin/gcc.exe" -m32`. An empty value means no compiler.
 */
export function compilerCommand(
	compilerPath: string,
	isFile: (candidate: string) => boolean,
	platform: NodeJS.Platform = process.platform,
): { readonly executable: string; readonly args: readonly string[] } | undefined {
	const trimmed = compilerPath.trim();
	if (!trimmed) {
		return undefined;
	}
	if (isFile(trimmed)) {
		return { executable: trimmed, args: [] };
	}
	const [executable, ...args] = tokenizeCommandLine(trimmed, platform === 'win32' ? 'windows' : 'posix');
	return executable ? { executable, args } : undefined;
}

/**
 * The compiler arguments of a configuration for a C or a C++ source. A recursive include path,
 * such as `${workspaceFolder}/**`, gives its base folder alone, because compilers do not search
 * below an include folder.
 */
export function configurationArguments(
	configuration: CppToolsConfiguration,
	dialect: ArgumentDialect,
	language: 'c' | 'cpp',
	compilerPathArguments: readonly string[] = [],
	platform: NodeJS.Platform = process.platform,
): string[] {
	const msvc = dialect === 'msvc';
	const includes = unique(
		configuration.includePath.map((folder) => folder.replace(/[\\/]\*{1,2}$/, '')).filter(Boolean),
	);
	const standard = language === 'c' ? configuration.cStandard : configuration.cppStandard;
	const standardArgument = standard ? standardArguments(standard, dialect, language) : [];
	return [
		...compilerPathArguments,
		...standardArgument,
		...unique(configuration.defines).map((define) => `${msvc ? '/D' : '-D'}${define}`),
		...includes.map((folder) => `${msvc ? '/I' : '-I'}${folder}`),
		// Only the macOS compilers know -F.
		...(platform === 'darwin' && !msvc
			? unique(configuration.macFrameworkPath).map((folder) => `-F${folder.replace(/[\\/]\*{1,2}$/, '')}`)
			: []),
		...configuration.forcedInclude.flatMap((file) => (msvc ? [`/FI${file}`] : ['-include', file])),
		...configuration.compilerArgs,
	];
}

/**
 * The switch that selects a language standard. cl.exe knows fewer standards than GCC and Clang, and
 * it has no GNU dialects, so `gnu++20` is `/std:c++20`. A standard that cl.exe does not know, such
 * as `c99`, gives no switch, and the compiler uses its default.
 */
export function standardArguments(standard: string, dialect: ArgumentDialect, language: 'c' | 'cpp'): string[] {
	const value = standard.trim().toLowerCase();
	if (!value || value === '${default}') {
		return [];
	}
	if (dialect === 'gnu') {
		return [`-std=${value}`];
	}
	const year = /^(?:gnu|c)(?:\+\+)?(\d\d)$/.exec(value)?.[1];
	if (!year) {
		return [];
	}
	const cpp = { '14': 'c++14', '17': 'c++17', '20': 'c++20', '23': 'c++latest', '26': 'c++latest' } as const;
	const c = { '11': 'c11', '17': 'c17', '18': 'c17', '23': 'clatest' } as const;
	const selected = language === 'cpp' ? cpp[year as keyof typeof cpp] : c[year as keyof typeof c];
	return selected ? [`/std:${selected}`] : [];
}

/**
 * The language of a source for its standard. The language of the open document applies first.
 * Without it, `.c` and Objective-C `.m` files are C, and the others are C++.
 */
export function sourceLanguage(file: string, languageId?: string): 'c' | 'cpp' {
	if (languageId === 'c' || languageId === 'objective-c') {
		return 'c';
	}
	if (languageId === 'cpp' || languageId === 'objective-cpp' || languageId === 'cuda') {
		return 'cpp';
	}
	return /\.(?:c|m)$/.test(file) ? 'c' : 'cpp';
}

/**
 * Expands `${workspaceFolder}`, `${workspaceRoot}`, `${workspaceFolderBasename}`, `${userHome}`,
 * `${env:NAME}`, `${env.NAME}`, and the string variables of the `env` object of the file. An
 * unknown variable stays.
 */
function expandVariables(
	value: string,
	variables: ReadonlyMap<string, string | readonly string[]>,
	context: CppToolsContext,
): string {
	return value.replace(/\$\{([^}]+)\}/g, (match, name: string) => {
		if (name === 'workspaceFolder' || name === 'workspaceRoot') {
			return context.workspaceFolder;
		}
		if (name === 'workspaceFolderBasename') {
			return path.basename(context.workspaceFolder);
		}
		if (name === 'userHome') {
			return context.userHome ?? os.homedir();
		}
		const environmentName = /^env[:.](.+)$/.exec(name)?.[1];
		if (environmentName !== undefined) {
			return context.environment[environmentName] ?? '';
		}
		const custom = variables.get(name);
		return typeof custom === 'string' ? custom : match;
	});
}

function customVariables(value: unknown): Map<string, string | readonly string[]> {
	const variables = new Map<string, string | readonly string[]>();
	if (isRecord(value)) {
		for (const [name, entry] of Object.entries(value)) {
			const list = stringList(entry);
			if (typeof entry === 'string') {
				variables.set(name, entry);
			} else if (list) {
				variables.set(name, list);
			}
		}
	}
	return variables;
}

function stringList(value: unknown): string[] | undefined {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined;
}

function unique(values: readonly string[]): string[] {
	return [...new Set(values)];
}

/**
 * Removes the comments and the trailing commas of a JSON file, as VS Code accepts them in its
 * configuration files. Text in strings stays.
 */
export function withoutJsonComments(text: string): string {
	let result = '';
	let index = 0;
	while (index < text.length) {
		const character = text[index];
		if (character === '"') {
			const end = stringEnd(text, index);
			result += text.slice(index, end);
			index = end;
		} else if (character === '/' && (text[index + 1] === '/' || text[index + 1] === '*')) {
			index = commentEnd(text, index);
		} else {
			// A comma before the end of an object or an array is a trailing comma.
			if (character !== ',' || !/[}\]]/.test(text[nextSignificant(text, index + 1)] ?? '')) {
				result += character;
			}
			index++;
		}
	}
	return result;
}

/** The index after a comment that starts at an index. */
function commentEnd(text: string, start: number): number {
	if (text[start + 1] === '/') {
		const end = text.indexOf('\n', start);
		return end < 0 ? text.length : end;
	}
	const end = text.indexOf('*/', start + 2);
	return end < 0 ? text.length : end + 2;
}

/** The index of the next character that is not white space or a comment. */
function nextSignificant(text: string, start: number): number {
	let index = start;
	while (index < text.length) {
		if (/\s/.test(text[index])) {
			index++;
		} else if (text[index] === '/' && (text[index + 1] === '/' || text[index + 1] === '*')) {
			index = commentEnd(text, index);
		} else {
			break;
		}
	}
	return index;
}

/** The index after the closing quote of the string that starts at an index. */
function stringEnd(text: string, start: number): number {
	let index = start + 1;
	while (index < text.length) {
		if (text[index] === '\\') {
			index += 2;
		} else if (text[index] === '"') {
			return index + 1;
		} else {
			index++;
		}
	}
	return text.length;
}
