import fs from 'node:fs';
import path from 'node:path';
import type { SourceOverlay } from '../types/index.js';

/** The files of a compile that reads unsaved text. They are in the temporary directory of the compile. */
export interface OverlayFiles {
	/** The saved source. The output of the compile names it. */
	readonly sourcePath: string;
	/** The file with the unsaved text. It has the name of the source, in a folder of its own. */
	readonly overlayPath: string;
	readonly temporaryDirectory: string;
}

/** How a compile reads the overlay file in place of the saved source. */
export interface OverlayInvocation {
	/** The input that the command line names. It is the source when the compiler maps the source to the overlay file. */
	readonly inputPath: string;
	/**
	 * Arguments after the default arguments of the toolchain and before the arguments of the
	 * project, such as an include folder that the compiler must search first.
	 */
	readonly leadingArguments?: readonly string[];
	/** Arguments after the arguments of the artifact. */
	readonly arguments?: readonly string[];
	/** Arguments after the input. */
	readonly trailingArguments?: readonly string[];
	/** Other files that the compile reads, by path, such as a VFS overlay of Clang. */
	readonly files?: Readonly<Record<string, string>>;
}

/** How a toolchain compiles unsaved text in place of the saved source. */
export interface SourceOverlaySpec {
	/** Text that comes before the unsaved text in the overlay file, such as a `#line` directive. */
	readonly header?: (sourcePath: string) => string;
	/** Why the toolchain cannot compile this text in place of the source, or nothing when it can. */
	readonly unsupported?: (text: string, sourcePath: string) => string | undefined;
	/** Changes the arguments of the artifact, such as `/FAcs` to `/FAc` for cl.exe. */
	readonly rewriteArguments?: (args: readonly string[]) => readonly string[];
	readonly invocation: (files: OverlayFiles) => OverlayInvocation;
}

/** The overlay file and the invocation of a compile, after the files are written. */
export interface PreparedOverlay {
	readonly files: OverlayFiles;
	readonly invocation: OverlayInvocation;
}

/**
 * Clang reads the overlay file through a virtual file system that maps the source to it. The
 * command line names the source. With `use-external-names` off, each output names the source too:
 * the assembly, the LLVM IR, the AST, the preprocessed output, the diagnostics, the dependencies,
 * the remarks, the stack usage, and the line tables. Clang 20, 21, and 22.1 do this. An include
 * of a header beside the source works, because the source keeps its folder.
 */
export function virtualFileSystemOverlay(
	overlayArguments: (overlayFile: string) => readonly string[],
): SourceOverlaySpec {
	return {
		invocation: ({ sourcePath, overlayPath, temporaryDirectory }) => {
			const overlayFile = path.join(temporaryDirectory, 'overlay.yaml');
			return {
				inputPath: sourcePath,
				arguments: overlayArguments(overlayFile),
				files: { [overlayFile]: virtualFileSystem(sourcePath, overlayPath) },
			};
		},
	};
}

/** A VFS overlay file of Clang that maps the source to the overlay file. JSON is also YAML. */
export function virtualFileSystem(sourcePath: string, overlayPath: string, platform = process.platform): string {
	const paths = platform === 'win32' ? path.win32 : path.posix;
	return JSON.stringify({
		version: 0,
		'case-sensitive': platform === 'linux' ? 'true' : 'false',
		'use-external-names': false,
		roots: [
			{
				name: paths.dirname(sourcePath),
				type: 'directory',
				contents: [{ name: paths.basename(sourcePath), type: 'file', 'external-contents': overlayPath }],
			},
		],
	});
}

/** A C `#line` directive that names the source. A backslash and a quotation mark get an escape. */
export function cLineDirective(sourcePath: string): string {
	return `#line 1 "${sourcePath.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"\n`;
}

/** A C# `#line` directive. A C# file name has no escapes, so it cannot hold a quotation mark. */
export function csharpLineDirective(sourcePath: string): string {
	return `#line 1 "${sourcePath}"\n`;
}

/**
 * The compiler reads the overlay file, and a `#line` directive at its start names the source. The
 * diagnostics and the line tables then name the source. The overlay file is in another folder, so
 * `#include "x.h"` needs the folder of the source as an include folder that comes first.
 */
export function lineDirectiveOverlay(options: {
	readonly directive: (sourcePath: string) => string;
	readonly includeArguments?: (sourceFolder: string, overlayFolder: string) => readonly string[];
	readonly rewriteArguments?: (args: readonly string[]) => readonly string[];
	/** A path character that the directive cannot hold. */
	readonly unsupportedPath?: RegExp;
}): SourceOverlaySpec {
	const unsupportedPath = options.unsupportedPath ?? /[\r\n]/u;
	return {
		header: options.directive,
		unsupported: (_text, sourcePath) =>
			unsupportedPath.test(sourcePath)
				? 'The path of the source has a character that a #line directive cannot name.'
				: undefined,
		...(options.rewriteArguments ? { rewriteArguments: options.rewriteArguments } : {}),
		invocation: ({ sourcePath, overlayPath }) => ({
			inputPath: overlayPath,
			leadingArguments: options.includeArguments?.(path.dirname(sourcePath), path.dirname(overlayPath)) ?? [],
		}),
	};
}

/**
 * GCC 14 to 16: the `#line` directive names the source in the diagnostics, the assembly, the dumps,
 * the remarks, and the stack usage. `-ffile-prefix-map` names it in the debug information, which
 * also has the name of the input. The quote include folder of the source comes before the others,
 * as the folder of the including file does. On Windows, the directive names the source with
 * forward slashes. No MinGW compiler was tested.
 */
export const gccSourceOverlay: SourceOverlaySpec = lineDirectiveOverlay({
	directive: (sourcePath) =>
		cLineDirective(process.platform === 'win32' ? sourcePath.replaceAll('\\', '/') : sourcePath),
	includeArguments: (sourceFolder, overlayFolder) => [
		'-iquote',
		sourceFolder,
		`-ffile-prefix-map=${overlayFolder}=${sourceFolder}`,
	],
});

/**
 * cl.exe 19.44 and 19.52 name the source in the diagnostics, the listing, and the line tables. They
 * ignore the `#line` name when they look for an include, so the folder of the source comes first.
 * This also changes the search for `<x.h>`. A `/FAcs` listing reads its source lines from the file
 * that `#line` names, which is the saved file, so the listing gets `/FAc` and its `; Line` comments.
 */
export const msvcSourceOverlay: SourceOverlaySpec = lineDirectiveOverlay({
	directive: cLineDirective,
	includeArguments: (sourceFolder) => ['/I', sourceFolder],
	rewriteArguments: (args) => args.map((argument) => (argument === '/FAcs' ? '/FAc' : argument)),
});

/** nvcc 13.4 names the source in the diagnostics and in the PTX. It has no quote include folders. */
export const nvccSourceOverlay: SourceOverlaySpec = lineDirectiveOverlay({
	directive: cLineDirective,
	includeArguments: (sourceFolder) => ['-I', sourceFolder],
});

/** Roslyn names the source in the diagnostics and in the program database. */
export const csharpSourceOverlay: SourceOverlaySpec = lineDirectiveOverlay({
	directive: csharpLineDirective,
	unsupportedPath: /["\r\n]/u,
});

/** Forms that make rustc read another file beside the source: a module file, `#[path]`, or `include!`. */
const rustFileReferences =
	/\bmod\s+(?:r#)?[\p{L}_][\p{L}\p{N}_]*\s*;|#\s*\[\s*path\b|\binclude(?:_str|_bytes)?!\s*[([{]/u;

/**
 * rustc 1.97 reads the overlay file, and `--remap-path-prefix` names the source in the
 * diagnostics, the assembly, the LLVM IR, and the MIR. rustc finds a module file beside the file
 * that it reads, so a crate with module files compiles the saved file.
 */
export const rustSourceOverlay: SourceOverlaySpec = {
	unsupported: (text) =>
		rustFileReferences.test(text)
			? 'The crate reads other files through mod, #[path], or include!, which rustc finds beside the saved file.'
			: undefined,
	invocation: ({ sourcePath, overlayPath }) => ({
		inputPath: overlayPath,
		arguments: [`--remap-path-prefix=${path.dirname(overlayPath)}=${path.dirname(sourcePath)}`],
	}),
};

/**
 * `go build -overlay` reads the overlay file in place of the source. Go 1.24 names the source in
 * the assembly. Its diagnostics name the overlay file relative to the working folder.
 */
export const goSourceOverlay: SourceOverlaySpec = {
	invocation: ({ sourcePath, overlayPath, temporaryDirectory }) => {
		const overlayFile = path.join(temporaryDirectory, 'overlay.json');
		return {
			inputPath: sourcePath,
			arguments: [`-overlay=${overlayFile}`],
			files: { [overlayFile]: JSON.stringify({ Replace: { [sourcePath]: overlayPath } }) },
		};
	},
};

/** The Python helpers compile the text of the second argument with the name of the first. */
export const pythonSourceOverlay: SourceOverlaySpec = {
	invocation: ({ sourcePath, overlayPath }) => ({ inputPath: sourcePath, trailingArguments: [overlayPath] }),
};

/** Writes the overlay file and the other files of the invocation into the temporary directory. */
export async function writeSourceOverlay(
	spec: SourceOverlaySpec,
	sourcePath: string,
	overlay: SourceOverlay,
	temporaryDirectory: string,
): Promise<PreparedOverlay> {
	const folder = path.join(temporaryDirectory, 'overlay');
	await fs.promises.mkdir(folder, { recursive: true });
	const files: OverlayFiles = {
		sourcePath,
		overlayPath: path.join(folder, path.basename(sourcePath)),
		temporaryDirectory,
	};
	const invocation = spec.invocation(files);
	const header = spec.header?.(sourcePath) ?? '';
	await fs.promises.writeFile(
		files.overlayPath,
		`${overlay.byteOrderMark ? '\uFEFF' : ''}${header}${overlay.text}`,
		'utf8',
	);
	await Promise.all(
		Object.entries(invocation.files ?? {}).map(([file, contents]) => fs.promises.writeFile(file, contents, 'utf8')),
	);
	return { files, invocation };
}

/**
 * Replaces the overlay file with the source in compiler output. Some outputs name the file that
 * the compiler read: the line markers of the preprocessed output of GCC, cl.exe, and nvcc, and the
 * Go diagnostics, which name it relative to the working folder. A Windows path can also have
 * forward slashes or doubled backslashes.
 */
export function withSourcePaths(
	text: string,
	files: Pick<OverlayFiles, 'sourcePath' | 'overlayPath'>,
	workingDirectory: string,
	platform: NodeJS.Platform = process.platform,
): string {
	const paths = platform === 'win32' ? path.win32 : path.posix;
	const forms = (overlay: string, source: string): Array<readonly [string, string]> =>
		platform === 'win32'
			? [
					[overlay.replaceAll('\\', '\\\\'), source.replaceAll('\\', '\\\\')],
					[overlay, source],
					[overlay.replaceAll('\\', '/'), source.replaceAll('\\', '/')],
				]
			: [[overlay, source]];
	const replacements = [
		...forms(files.overlayPath, files.sourcePath),
		...forms(
			paths.relative(workingDirectory, files.overlayPath),
			paths.relative(workingDirectory, files.sourcePath),
		),
	];
	let result = text;
	for (const [from, to] of replacements) {
		if (from && result.length > 0) {
			result = result.replace(new RegExp(escapeRegExp(from), platform === 'win32' ? 'gi' : 'g'), () => to);
		}
	}
	return result;
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The byte order mark of a saved file that can get an overlay file, or nothing when it cannot. The
 * overlay file is UTF-8, so the saved file must be UTF-8 too. Otherwise the compiler reads other
 * bytes than it reads from the saved file. cl.exe reads a file without a mark in the code page of
 * the system, so the overlay file copies the mark.
 */
export function overlayEncoding(savedFile: Uint8Array): { readonly byteOrderMark: boolean } | undefined {
	try {
		new TextDecoder('utf-8', { fatal: true }).decode(savedFile);
	} catch {
		return undefined;
	}
	return { byteOrderMark: savedFile[0] === 0xef && savedFile[1] === 0xbb && savedFile[2] === 0xbf };
}
