import path from 'node:path';
import type { ParsedAsmResult } from '../../vendor/types/asmresult/asmresult.interfaces.js';
import { absoluteLocalPath, localFileComparisonKey, resolveCompilerPath } from '../../file-identity.js';

/** The file being compiled, and the directory its compiler ran in. */
export interface MainSource {
	readonly path: string;
	readonly workingDirectory: string;
}

/**
 * The vendored parser recognizes the compiled file only by Compiler Explorer's
 * placeholder names, so "Hide library code" would otherwise treat every real
 * path as a library and remove the whole listing.
 */
const mainSourcePlaceholder = '<source>';

/** The same file directive forms that the vendored parser reads: `.file N "name"` and `.file N "dir" "name"`. */
const fileDirective = /^([ \t]*\.(cv_)?file[ \t]+\d+[ \t]+)"([^"]+)"(?:[ \t]+"([^"]+)")?.*$/gm;

/** Returns a test for compiler-reported filenames that name the main source. Results are cached per name. */
export function mainSourceTest(mainSource: MainSource): (filename: string) => boolean {
	const mainPath = absoluteLocalPath(mainSource.path);
	const mainKey = localFileComparisonKey(mainPath);
	const verdicts = new Map<string, boolean>();
	return (filename) => {
		let verdict = verdicts.get(filename);
		if (verdict === undefined) {
			const candidate = resolveCompilerPath(filename, mainSource.workingDirectory);
			verdict = sameSpelling(candidate, mainPath) || localFileComparisonKey(candidate) === mainKey;
			verdicts.set(filename, verdict);
		}
		return verdict;
	};
}

/** Renames the main source in the file directives of an assembly listing to the parser's placeholder. */
export function markMainSource(rawAssembly: string, mainSource: MainSource): string {
	const isMainSource = mainSourceTest(mainSource);
	return rawAssembly.replace(
		fileDirective,
		(line, prefix: string, codeView: string | undefined, first: string, second: string | undefined) => {
			// `.cv_file N "name" "checksum"` names the file first; `.file N "dir" "name"` names it second.
			const directory = unescapeAssemblyString(first);
			const name = second === undefined || codeView ? undefined : unescapeAssemblyString(second);
			const filename =
				name === undefined || path.isAbsolute(name) ? (name ?? directory) : path.join(directory, name);
			return isMainSource(filename) ? `${prefix}"${mainSourcePlaceholder}"` : line;
		},
	);
}

/**
 * Restores the main source path in parsed lines. The parser reports the
 * placeholder, or no file at all when filenames are masked.
 */
export function withMainSourcePath(parsed: ParsedAsmResult, mainSource: MainSource): ParsedAsmResult {
	return {
		...parsed,
		asm: parsed.asm.map((line) =>
			line.source && (line.source.file === null || line.source.file === mainSourcePlaceholder)
				? { ...line, source: { ...line.source, file: mainSource.path, mainsource: true } }
				: line,
		),
	};
}

function unescapeAssemblyString(value: string): string {
	return value.replace(/\\(.)/g, '$1');
}

function sameSpelling(left: string, right: string): boolean {
	return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}
