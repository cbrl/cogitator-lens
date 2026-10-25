import { resolveCompilerPath, sameLocalFileTest } from '../../file-identity.js';

/**
 * Whether a declaration's file is a compiler or platform header rather than the compiled file,
 * which `isMainSource` recognizes.
 */
export function isSystemDeclarationPath(filename: string, isMainSource: (filename: string) => boolean): boolean {
	const normalized = filename.replace(/\\/g, '/').toLowerCase();
	const system =
		normalized.startsWith('/usr/include/') ||
		normalized.includes('/lib/clang/') ||
		normalized.includes('/windows kits/') ||
		normalized.includes('/microsoft visual studio/') ||
		normalized.includes('.app/contents/developer/toolchains/') ||
		normalized.includes('/xcode.app/');
	return system && !isMainSource(filename);
}

/**
 * Creates a filter for the lines of one `-ast-dump` that drops each top-level declaration from a
 * system header or from the compiler itself, with its subtree, as Clang prints it. Including the
 * standard library otherwise produces tens of megabytes of declarations that the renderer would
 * hide anyway.
 *
 * Clang prints a filename only when it differs from the last one it printed, so every line is
 * read for filenames, and a declaration that starts with a relative location is in that file.
 */
export function systemDeclarationFilter(sourceFile: string, workingDirectory: string): (line: string) => boolean {
	let lastFile: string | undefined;
	let keepDeclaration = true;
	const isMainSource = sameLocalFileTest(sourceFile);
	const systemFiles = new Map<string, boolean>();
	const isSystem = (filename: string): boolean => {
		let system = systemFiles.get(filename);
		if (system === undefined) {
			system = isSystemDeclarationPath(resolveCompilerPath(filename, workingDirectory), isMainSource);
			systemFiles.set(filename, system);
		}
		return system;
	};
	return (line) => {
		const topLevel = line.startsWith('|-') || line.startsWith('`-');
		if (topLevel) {
			const start = firstLocation(line);
			const file = start === undefined ? undefined : start.file === undefined ? lastFile : start.file;
			keepDeclaration = !isCompilerDeclaration(line) && (file === undefined || !isSystem(file));
		}
		for (const file of explicitFiles(line)) {
			lastFile = file;
		}
		return keepDeclaration || !(topLevel || line.startsWith('| ') || line.startsWith('  '));
	};
}

/** Whether a top-level node is one the compiler declares itself, such as `__int128_t`, with no source location. */
export function isCompilerDeclaration(line: string): boolean {
	return line.includes('<<invalid sloc>>');
}

/** The start of a node's source range: a file, or no file for a location relative to the last one. */
function firstLocation(line: string): { readonly file?: string } | undefined {
	const range = /<([^<>]*)>/.exec(line);
	const token = range?.[1].split(',')[0].trim();
	if (!token) {
		return undefined;
	}
	const explicit = explicitFile(token);
	if (explicit) {
		return { file: explicit };
	}
	return /^(?:line:\d+:\d+|col:\d+)$/.test(token) ? {} : undefined;
}

/** The filenames a line prints, in order: those in its ranges, then those after them. */
function explicitFiles(line: string): string[] {
	const files: string[] = [];
	for (const range of line.matchAll(/<([^<>]*)>/g)) {
		for (const token of range[1].split(',')) {
			const file = explicitFile(token.trim());
			if (file) {
				files.push(file);
			}
		}
	}
	for (const token of line.replace(/<[^<>]*>/g, ' ').split(/\s+/)) {
		const file = explicitFile(token);
		if (file) {
			files.push(file);
		}
	}
	return files;
}

function explicitFile(token: string): string | undefined {
	const match = /^(.*):\d+:\d+$/.exec(token);
	return match && match[1] !== 'line' && match[1] !== '<invalid sloc>' && match[1] !== '<built-in>'
		? match[1]
		: undefined;
}
