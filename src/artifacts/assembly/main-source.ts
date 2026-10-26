import path from 'node:path';
import type { ParsedAsmResult } from '../../vendor/types/asmresult/asmresult.interfaces.js';
import { sameLocalFileTest } from '../../file-identity.js';

/** The file being compiled, and the directory its compiler ran in. */
export interface MainSource {
	readonly path: string;
	readonly workingDirectory: string;
}

/**
 * The vendored parsers recognize the compiled file only by Compiler Explorer's placeholder
 * names, so "Hide library code" would otherwise treat every real path as a library and remove
 * the whole listing. They find the placeholder anywhere in a name, so a number after it tells
 * which spelling it replaced.
 */
const mainSourcePlaceholder = '<source>';
const placeholderToken = /"<source>\d+"|<source>\d+/g;

/**
 * The same file directive forms that the vendored parser reads, `.file N "name"` and
 * `.file N "dir" "name"`, with whatever follows them, such as an MD5 checksum.
 */
const fileDirective = /^([ \t]*\.(cv_)?file[ \t]+\d+[ \t]+)("([^"]+)"(?:[ \t]+"([^"]+)")?)(.*)$/gm;
/** The file comment of an MSVC listing, which names the file of the lines after it. */
const msvcFileComment = /^(; File )([^\r\n]+)/gm;

/**
 * Parses an assembly listing with the compiled file renamed to the parser's placeholder in its
 * file directives and MSVC file comments, then restores the real names in the parsed lines and
 * their sources. Escaped bytes in GNU file names are decoded, so a path with non-ASCII
 * characters names the file it is.
 */
export function parseWithMainSource(
	rawAssembly: string,
	mainSource: MainSource,
	parse: (assembly: string) => ParsedAsmResult,
): ParsedAsmResult {
	const isMainSource = sameLocalFileTest(mainSource.path, mainSource.workingDirectory);
	const originals = new Map<string, string>();
	const mark = (original: string, quoted: boolean): string => {
		const name = `${mainSourcePlaceholder}${originals.size}`;
		const token = quoted ? `"${name}"` : name;
		originals.set(token, original);
		return token;
	};
	// The parser reports a file by the name it read, escapes and all.
	const decodedNames = new Map<string, string>();
	const marked = rawAssembly
		.replace(
			fileDirective,
			(
				line,
				prefix: string,
				codeView: string | undefined,
				names: string,
				first: string,
				second: string | undefined,
				rest: string,
			) => {
				// `.cv_file N "name" "checksum"` names the file first; `.file N "dir" "name"` names it second.
				const name = codeView ? undefined : second;
				const decodedDirectory = unescapeAssemblyString(first);
				const decodedName = name === undefined ? undefined : unescapeAssemblyString(name);
				const filename =
					decodedName === undefined
						? decodedDirectory
						: path.isAbsolute(decodedName)
							? decodedName
							: path.join(decodedDirectory, decodedName);
				if (isMainSource(filename)) {
					return `${prefix}${mark(names, true)}${rest}`;
				}
				if (names.includes('\\')) {
					decodedNames.set(parserFileName(first, name), parserFileName(decodedDirectory, decodedName));
				}
				return line;
			},
		)
		.replace(msvcFileComment, (line, prefix: string, filename: string) =>
			isMainSource(filename.trim()) ? `${prefix}${mark(filename, false)}` : line,
		);
	const parsed = parse(marked);
	return {
		...parsed,
		asm: parsed.asm.map((line) => {
			const text = line.text.includes(mainSourcePlaceholder)
				? line.text.replace(placeholderToken, (token) => originals.get(token) ?? token)
				: line.text;
			const file = line.source?.file;
			const source = !line.source
				? line.source
				: file === null || file?.startsWith(mainSourcePlaceholder)
					? { ...line.source, file: mainSource.path, mainsource: true }
					: file !== undefined && decodedNames.has(file)
						? { ...line.source, file: decodedNames.get(file)! }
						: line.source;
			return text === line.text && source === line.source ? line : { ...line, text, source };
		}),
	};
}

/** The name the vendored parser gives a file directive's file. */
function parserFileName(directory: string, name: string | undefined): string {
	return name === undefined ? directory : name.startsWith('/') ? name : `${directory}/${name}`;
}

const assemblyStringPart = /\\([0-7]{1,3}|[^])|[^\\]+|\\$/g;
const namedEscapes: Readonly<Record<string, number>> = { b: 8, f: 12, n: 10, r: 13, t: 9 };

/**
 * Decodes a GNU assembler string. GCC and LLVM write each byte outside printable ASCII as an
 * octal escape, so the bytes of a UTF-8 path are decoded together.
 */
export function unescapeAssemblyString(value: string): string {
	if (!value.includes('\\')) {
		return value;
	}
	const bytes: Buffer[] = [];
	for (const [part, escaped] of value.matchAll(assemblyStringPart)) {
		if (escaped === undefined) {
			bytes.push(Buffer.from(part, 'utf8'));
		} else if (/^[0-7]/.test(escaped)) {
			bytes.push(Buffer.of(Number.parseInt(escaped, 8) & 0xff));
		} else {
			bytes.push(
				namedEscapes[escaped] === undefined ? Buffer.from(escaped, 'utf8') : Buffer.of(namedEscapes[escaped]),
			);
		}
	}
	return Buffer.concat(bytes).toString('utf8');
}
