import fs from 'node:fs';
import path from 'node:path';
import type { AuxiliaryTool } from '../types/index.js';
import { renderJavaBytecode } from '../artifacts/java/java-bytecode-renderer.js';
import { ToolExitError, type DependencyCollectionSpec } from './toolchain-backend.js';
import {
	withoutOwnedArguments,
	type ArtifactProducer,
	type InvocationRunner,
	type ToolchainDefinition,
} from './toolchain-contracts.js';
import { parseJavacDiagnostics } from './java/diagnostics.js';
import { javaSourceOverlay } from './source-overlay.js';
import { environmentValue } from './version-banner.js';

/**
 * Compiles the source with javac, then lists the class files with javap. javac writes one class
 * file for each class, also for each nested, local, and anonymous class.
 */
export const javaBytecodeProducer: ArtifactProducer = async (backend, source, options, cancellationToken) => {
	const text = options.sourceOverlay?.text ?? (await fs.promises.readFile(source.fsPath, 'utf8').catch(() => ''));
	const sourceRoot = javaSourceRoot(source.fsPath, text);
	return backend.produceWithTool(
		source,
		options,
		{
			// javac 8 does not make a missing output directory, so the class files go into the
			// temporary directory of the compile.
			workspaceFiles: { classes: '.' },
			compilerArguments: (files, providerArguments) =>
				javacArguments(files.classes, providerArguments, sourceRoot),
			tool: 'javap',
			toolArguments: async (files) => {
				const classes = await classFiles(files.classes);
				return classes.length > 0 ? javapArguments(classes) : undefined;
			},
		},
		cancellationToken,
	);
};

/**
 * javac writes its diagnostics and its `-verbose` lines in the language of the system, but the
 * extension reads only the English lines. The last value of a JVM property is the value that
 * javac uses.
 */
const englishMessages = '-J-Duser.language=en';

/**
 * The javac arguments of the extension. `-implicit:none` keeps the class files of the other sources
 * that the compile reads out of the listing. A provider argument for the encoding or the source
 * path replaces the one of the extension.
 */
export function javacArguments(
	classDirectory: string,
	providerArguments: readonly string[],
	sourceRoot: string | undefined,
): readonly string[] {
	const has = (pattern: RegExp): boolean => providerArguments.some((argument) => pattern.test(argument));
	return [
		'-d',
		classDirectory,
		'-implicit:none',
		englishMessages,
		...(has(/^-encoding$/u) ? [] : ['-encoding', 'UTF-8']),
		...(sourceRoot && !has(/^(?:-sourcepath|--source-path|--module-source-path)(?:=|$)/u)
			? ['-sourcepath', sourceRoot]
			: []),
	];
}

/** javap lists the code, the line numbers, the private members, and the constant values of each class. */
export function javapArguments(classFiles: readonly string[]): readonly string[] {
	return ['-c', '-l', '-p', '-constants', ...classFiles];
}

/**
 * The folder that holds the package folders of the source, from its `package` declaration. javac
 * finds the other classes of the package and of the project there. A source in the unnamed package
 * has its own folder. When the folders of the source do not match its package, there is no root.
 */
export function javaSourceRoot(
	sourcePath: string,
	text: string,
	platform: NodeJS.Platform = process.platform,
): string | undefined {
	const paths = platform === 'win32' ? path.win32 : path.posix;
	let folder = paths.dirname(sourcePath);
	const packageName = javaPackage(text);
	if (!packageName) {
		return folder;
	}
	const sameName = (left: string, right: string): boolean =>
		platform === 'linux' ? left === right : left.toLowerCase() === right.toLowerCase();
	for (const segment of packageName.split('.').reverse()) {
		if (!sameName(paths.basename(folder), segment)) {
			return undefined;
		}
		folder = paths.dirname(folder);
	}
	return folder;
}

const identifier = String.raw`[\p{L}_$][\p{L}\p{N}_$]*`;
/**
 * A comment, a text block, a string, or a character. Each match starts at the first of these, so a
 * `/*` in a line comment or a `//` in a string does not start a comment.
 */
const commentOrLiteral =
	/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"""(?:\\[\s\S]|[^\\])*?"""|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/gu;
/** A pair of parentheses with no parentheses in it. */
const innerParentheses = /\([^()]*\)/gu;
/** A package declaration after the annotations of a `package-info.java`, without their arguments. */
const packageDeclaration = new RegExp(
	String.raw`^\s*(?:@[\p{L}_$][\p{L}\p{N}_$.]*\s*)*package\s+(${identifier}(?:\s*\.\s*${identifier})*)\s*;`,
	'u',
);

/** The package of a source, or nothing for the unnamed package. */
export function javaPackage(text: string): string | undefined {
	const code = text.replace(/^﻿/u, '').replace(commentOrLiteral, ' ');
	// The package declaration is the first statement. An annotation argument can hold annotations
	// with arguments, so the parentheses go from the innermost pair out.
	let declaration = code.slice(0, code.indexOf(';') + 1);
	for (let previous = ''; previous !== declaration;) {
		previous = declaration;
		declaration = declaration.replace(innerParentheses, ' ');
	}
	return packageDeclaration.exec(declaration)?.[1].replace(/\s+/gu, '');
}

/** The class files in a folder and its subfolders, in the order of their class names. */
export async function classFiles(folder: string): Promise<string[]> {
	const found: string[] = [];
	const visit = async (directory: string): Promise<void> => {
		for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
			const child = path.join(directory, entry.name);
			if (entry.isDirectory()) {
				await visit(child);
			} else if (entry.isFile() && entry.name.endsWith('.class')) {
				found.push(child);
			}
		}
	};
	await visit(folder);
	return found
		.map((file) => ({ file, name: classNameParts(path.relative(folder, file)) }))
		.sort((left, right) => compareClassNames(left.name, right.name))
		.map(({ file }) => file);
}

/** The package folders and the nested class names of a class file, such as `p`, `Outer`, and `1`. */
function classNameParts(relativePath: string): string[] {
	return relativePath
		.replace(/\.class$/u, '')
		.split(/[\\/]/u)
		.flatMap((part, index, parts) => (index === parts.length - 1 ? part.split('$') : [part]));
}

/**
 * A class comes before its nested classes, and anonymous classes come in the order of their numbers,
 * so `Outer$2` comes before `Outer$10`.
 */
export function compareClassNames(left: readonly string[], right: readonly string[]): number {
	for (let index = 0; index < Math.min(left.length, right.length); index++) {
		const [a, b] = [left[index], right[index]];
		if (a === b) {
			continue;
		}
		if (/^\d+$/u.test(a) && /^\d+$/u.test(b)) {
			return Number(a) - Number(b);
		}
		return a < b ? -1 : 1;
	}
	return left.length - right.length;
}

/** Removes the class output folders and the input listing that the extension owns. */
export function stripJavaManagedArguments(
	args: readonly string[],
	sourceFile: string,
	workingDirectory: string,
): readonly string[] {
	return withoutOwnedArguments(args, sourceFile, workingDirectory, {
		withValue: [new Set(['-d', '-s', '-h'])],
		standalone: [/^-implicit:/u, /^-J-Duser\.language=/u, new Set(['-verbose'])],
	});
}

/** The file that the compile writes its `-verbose` lines into, so they are not compiler output. */
const javacInputsFile = 'javac-inputs.txt';
const verboseArgument = '-verbose';
/** A `-verbose` line of javac, such as `[parsing started SimpleFileObject[...]]`. */
const verboseLine = /^\[.*\]\s*$/u;

/**
 * javac has no dependency file. With `-verbose`, it names each source that it parses and each class
 * file that it loads, so the main compile also lists its inputs.
 */
export const javacDependencyCollection: DependencyCollectionSpec = {
	outputFilename: javacInputsFile,
	inlineArguments: () => [verboseArgument],
	parse: javacVerboseInputs,
};

/**
 * Runs javac, and moves its `-verbose` lines from its output into the input listing. The other
 * lines are the diagnostics, also when javac fails.
 */
export const runJavac: InvocationRunner = async (run) => {
	if (!run.arguments.includes(verboseArgument)) {
		return run.execute(run.arguments);
	}
	try {
		const result = await run.execute(run.arguments);
		const stderr = splitVerboseLines(result.stderr);
		const stdout = splitVerboseLines(result.stdout);
		await fs.promises.writeFile(
			path.join(run.temporaryDirectory, javacInputsFile),
			[...stderr.verbose, ...stdout.verbose].join('\n'),
		);
		return { ...result, stdout: stdout.other, stderr: stderr.other };
	} catch (error) {
		if (error instanceof ToolExitError) {
			throw new ToolExitError(
				error.message,
				error.returnCode,
				splitVerboseLines(error.stdout).other,
				splitVerboseLines(error.stderr).other,
			);
		}
		throw error;
	}
};

export function splitVerboseLines(text: string): { readonly verbose: string[]; readonly other: string } {
	const verbose: string[] = [];
	const other: string[] = [];
	for (const line of text.split(/(?<=\n)/u)) {
		(verboseLine.test(line) ? verbose : other).push(line);
	}
	return { verbose: verbose.map((line) => line.trimEnd()), other: other.join('') };
}

/**
 * A class of the JDK that is not a file. javac 9 and later load the classes of the JDK from
 * `/modules/`. With `--release`, they load `.sig` files from `ct.sym`, such as
 * `/89A/java.base/java/io/Serializable.sig`.
 */
const jdkClass = /^(?:\/modules\/|jrt:)|\.sig$/iu;

/**
 * The files in the `-verbose` lines of javac: the sources that it parses and the class files that
 * it loads. A file in a JAR file, or in the `ct.sym` file of javac 8, gives that file. When an
 * option of the environment changes the language of the lines, the list is empty. The backend
 * then does not use the output again.
 */
export function javacVerboseInputs(text: string, workingDirectory: string): readonly string[] {
	const inputs = new Set<string>();
	for (const line of text.split(/\r?\n/u)) {
		const reference = /^\[(?:parsing started|loading) (.+)\]\s*$/u.exec(line);
		const file = reference && fileObjectPath(reference[1]);
		if (file && !jdkClass.test(file)) {
			inputs.add(path.resolve(workingDirectory, file));
		}
	}
	return [...inputs];
}

/**
 * The path of a javac file object. `DirectoryFileObject[src:p/A.java]` names a folder of the source
 * path and a path in it. `lib.jar(/p/A.class)` names a file in a JAR file, and javac 8 names the
 * classes of the JDK as `lib\ct.sym(META-INF/sym/rt.jar/java/lang/Object.class)`.
 */
function fileObjectPath(reference: string): string | undefined {
	const wrapped = /^(\w+)FileObject\[(.*)\]$/u.exec(reference);
	let file = wrapped ? wrapped[2] : reference;
	if (wrapped?.[1] === 'Directory') {
		const separator = file.lastIndexOf(':');
		if (separator <= 0) {
			return undefined;
		}
		file = path.join(file.slice(0, separator), file.slice(separator + 1));
	}
	const archive = /^(.*\.(?:jar|zip|sym))\(.*\)$/iu.exec(file);
	return archive ? archive[1] : file || undefined;
}

/**
 * Finds javap for a javac: beside it, beside the file that a link names, then in `JAVA_HOME` and on
 * PATH. The Oracle installer puts a copy of the javac launcher into a `javapath` folder without
 * javap. The launcher runs the newest Oracle JDK, so its javap comes from the newest JDK folder.
 */
export function findJavap(
	executable: string,
	environment: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): string | undefined {
	const name = platform === 'win32' ? 'javap.exe' : 'javap';
	const javaHome = environmentValue(environment, 'JAVA_HOME', platform);
	const oracleLauncher = platform === 'win32' && /^javapath/iu.test(path.basename(path.dirname(executable)));
	const candidates = [
		path.join(path.dirname(executable), name),
		path.join(path.dirname(realPath(executable)), name),
		...(oracleLauncher ? oracleJdkTools(environment, name) : []),
		...(javaHome ? [path.join(javaHome, 'bin', name)] : []),
		...(environmentValue(environment, 'PATH', platform) ?? '')
			.split(path.delimiter)
			.filter((directory) => directory && path.isAbsolute(directory))
			.map((directory) => path.join(directory, name)),
	];
	return candidates.find((candidate) => isFile(candidate));
}

export function discoverJavaTools(executable: string): Readonly<Record<string, AuxiliaryTool>> {
	const javap = findJavap(executable);
	const tools: Record<string, AuxiliaryTool> = javap
		? { javap: Object.freeze({ executable: javap, inputMode: 'file-argument' }) }
		: {};
	return Object.freeze(tools);
}

/** The tool in each JDK folder of the Oracle installer, newest version first. */
function oracleJdkTools(environment: NodeJS.ProcessEnv, name: string): string[] {
	const programFiles =
		environmentValue(environment, 'ProgramW6432', 'win32') ??
		environmentValue(environment, 'ProgramFiles', 'win32');
	if (!programFiles) {
		return [];
	}
	const javaFolder = path.join(programFiles, 'Java');
	const latestFolder = path.join(javaFolder, 'latest');
	return [...childFolders(javaFolder), ...childFolders(latestFolder)]
		.filter((folder) => /^jdk/iu.test(path.basename(folder)))
		.sort((left, right) => compareVersionsDescending(path.basename(left), path.basename(right)))
		.map((folder) => path.join(folder, 'bin', name));
}

function childFolders(folder: string): string[] {
	try {
		return fs
			.readdirSync(folder, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
			.map((entry) => path.join(folder, entry.name));
	} catch {
		return [];
	}
}

function compareVersionsDescending(left: string, right: string): number {
	const leftParts = left.match(/\d+/gu)?.map(Number) ?? [];
	const rightParts = right.match(/\d+/gu)?.map(Number) ?? [];
	for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index++) {
		const difference = (rightParts[index] ?? -1) - (leftParts[index] ?? -1);
		if (difference !== 0) {
			return difference;
		}
	}
	return right.localeCompare(left);
}

function realPath(file: string): string {
	try {
		return fs.realpathSync(file);
	} catch {
		return file;
	}
}

function isFile(file: string): boolean {
	try {
		return fs.statSync(file).isFile();
	} catch {
		return false;
	}
}

export const java: ToolchainDefinition = {
	executablePattern: /^javac(?:\.exe)?$/i,
	parseDiagnostics: parseJavacDiagnostics,
	languageIdentifiers: Object.freeze(['java']),
	stripOwnedArguments: stripJavaManagedArguments,
	sourceOverlay: javaSourceOverlay,
	dependencyCollection: javacDependencyCollection,
	runInvocation: runJavac,
	discoverTools: discoverJavaTools,
	artifacts: {
		assembly: {
			producer: javaBytecodeProducer,
			renderer: renderJavaBytecode,
			listingSyntax: 'java-bytecode',
			requiredTools: [{ name: 'javap', label: 'Java class file disassembler (javap)' }],
		},
	},
};
