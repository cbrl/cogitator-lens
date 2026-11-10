import path from 'path';
import type { ArtifactProducer } from '../../toolchains/toolchain-contracts.js';
import { requiredFunctionFilter } from './pipeline-producer.js';
import { pipelineRenderer, type ParsedPipeline } from './pipeline-renderer.js';

/** The name of a GCC pass dump, `<base>.<number><kind>.<pass>`, such as `output.c.271r.expand`. */
const dumpFilename = /\.(\d+)([tri])\.([\w-]+)$/u;

/**
 * The header of the section of one function in a pass dump. The name in the parentheses is the
 * assembler name. The dump of the front end gives `(null)` in its place, so no function matches it.
 */
const functionHeader = /^;; Function (.*) \(([^\s(),]+), funcdef_no=/u;
const sectionStart = ';; Function ';

/**
 * The first line of the collected text names the function. The line before the code of each pass
 * names the pass, such as `;;;; Pass 271r.expand`. The line of a pass that does not change the code
 * ends with `(unchanged)`, and no code follows it.
 */
const functionMarker = /^;;;; Function (.*)$/u;
const passMarker = /^;;;; Pass \d+([tri])\.([\w-]+)( \(unchanged\))?$/u;
const unchanged = '(unchanged)';

const passKinds: Readonly<Record<string, string>> = { t: 'tree', i: 'ipa', r: 'rtl' };

/**
 * Runs GCC with the dumps of each tree, IPA, and RTL pass, and keeps the sections of one function.
 * GCC has no option that dumps one function, so the dumps of a large source can be very large.
 */
export const gccPipelineProducer: ArtifactProducer = async (backend, source, options, cancellationToken) => {
	const functionFilter = requiredFunctionFilter(options);
	return backend.produceArtifact(
		source,
		options,
		{
			output: {
				directory: 'dumps',
				collect: (files, read) => collectGccFunctionDumps(files, read, functionFilter),
			},
			// GCC names the dumps after the output file, and -dumpdir keeps them in the directory.
			arguments: (directory) => [
				'-c',
				'-o',
				path.join(directory, 'output.o'),
				'-dumpdir',
				`${directory}${path.sep}`,
				'-fdump-tree-all',
				'-fdump-ipa-all',
				'-fdump-rtl-all',
			],
		},
		cancellationToken,
	);
};

/**
 * Collects the code of one function from the GCC pass dumps, in the order that the passes ran. The
 * code is the end of the section of the function in each dump. The notes and the data flow of the
 * pass before the code are left out, so a pass changes the function only when it changes the code.
 * The name of the function in the text is the name that GCC prints, such as `geometry::manhattan`.
 */
export async function collectGccFunctionDumps(
	files: readonly string[],
	read: (file: string) => Promise<string>,
	assemblerName: string,
): Promise<string> {
	const dumps = files
		.flatMap((file) => {
			const match = dumpFilename.exec(file);
			return match
				? [{ file, number: Number(match[1]), kind: match[2], pass: `${match[1]}${match[2]}.${match[3]}` }]
				: [];
		})
		.sort((left, right) => left.number - right.number || left.pass.localeCompare(right.pass));
	// The cold part of a function, such as `f.cold`, has a symbol of its own, but no dump section.
	const name = assemblerName.replace(/\.cold(?:\.\d+)?$/u, '');
	// On some targets, such as 32-bit Windows, a symbol has one more leading underscore than its
	// assembler name.
	const names = name.startsWith('_') ? [name, name.slice(1)] : [name];
	const collected = names.map(() => ({ name: assemblerName, lines: [] as string[], previous: '' }));
	for (const dump of dumps) {
		const text = await read(dump.file);
		names.forEach((candidate, index) => {
			const [header, ...lines] = functionLines(text, candidate);
			if (header === undefined) {
				return;
			}
			const target = collected[index];
			if (target.lines.length === 0) {
				target.name = functionHeader.exec(header)?.[1] ?? assemblerName;
			}
			// The code of a pass that does not change it is not repeated.
			const code = (dump.kind === 'r' ? rtlCode(lines) : treeCode(lines)).join('\n');
			target.lines.push(
				code === target.previous ? `;;;; Pass ${dump.pass} ${unchanged}` : `;;;; Pass ${dump.pass}\n${code}`,
			);
			target.previous = code;
		});
	}
	const found = collected.find((target) => target.lines.length > 0) ?? collected[0];
	return [`;;;; Function ${found.name}`, ...found.lines].join('\n');
}

/**
 * The first header of one function in a dump, and the lines of each section of the function after
 * its header. A section ends at the next function header.
 */
function functionLines(text: string, assemblerName: string): string[] {
	if (!text.includes(assemblerName)) {
		return [];
	}
	const starts: number[] = [];
	for (
		let index = text.startsWith(sectionStart) ? 0 : text.indexOf(`\n${sectionStart}`);
		index >= 0;
		index = text.indexOf(`\n${sectionStart}`, index + 1)
	) {
		starts.push(text[index] === '\n' ? index + 1 : index);
	}
	const lines: string[] = [];
	starts.forEach((start, index) => {
		const end = starts[index + 1] ?? text.length;
		const headerEnd = text.indexOf('\n', start);
		const header = text.slice(start, headerEnd < 0 || headerEnd > end ? end : headerEnd).trimEnd();
		if (functionHeader.exec(header)?.[2] !== assemblerName) {
			return;
		}
		if (lines.length === 0) {
			lines.push(header);
		}
		if (headerEnd >= 0 && headerEnd < end) {
			lines.push(...text.slice(headerEnd + 1, end).split(/\r?\n/u));
		}
	});
	return lines;
}

/** Reads the passes of a GCC pipeline from the collected code of one function. */
export function parseGccPipeline(text: string): ParsedPipeline {
	const sections: { kind: string; name: string; unchanged: boolean; lines: string[] }[] = [];
	let functionName: string | undefined;
	for (const line of text.split(/\r?\n/u)) {
		const marker = passMarker.exec(line);
		if (marker) {
			const name = `${marker[2]} (${passKinds[marker[1]]})`;
			sections.push({ kind: marker[1], name, unchanged: marker[3] !== undefined, lines: [] });
		} else if (sections.length > 0) {
			sections[sections.length - 1].lines.push(line);
		} else {
			functionName ??= functionMarker.exec(line)?.[1];
		}
	}
	let before = '';
	const passes = sections.map((section) => {
		const after = section.unchanged ? before : section.lines.join('\n').trimEnd();
		const pass = { name: section.name, machine: section.kind === 'r', before, after, extension: '.txt' };
		before = after;
		return pass;
	});
	return { functionName, passes };
}

/** The name of each pass gives its kind, so no suffix marks the RTL passes. */
export const renderGccOptimizationPipeline = pipelineRenderer((raw) => parseGccPipeline(raw.text), '');

/** The last function body of a tree or IPA dump: its declaration, `{`, and `}`. */
function treeCode(lines: readonly string[]): readonly string[] {
	const close = lastIndex(lines, lines.length, (line) => line.trimEnd() === '}');
	const open = lastIndex(lines, close, (line) => line.trimEnd() === '{');
	if (open < 1) {
		return trimmed(lines);
	}
	let start = open - 1;
	while (start > 0 && lines[start - 1].startsWith('__attribute__')) {
		start--;
	}
	return lines.slice(start, close + 1);
}

/**
 * The instruction list at the end of an RTL dump. Each line of the list starts with `(` or white
 * space. The lines before the list hold the notes and the data flow of the pass.
 */
function rtlCode(lines: readonly string[]): readonly string[] {
	const code = trimmed(lines);
	let start = code.length;
	while (start > 0 && /^[(\s]/u.test(code[start - 1])) {
		start--;
	}
	const first = code.findIndex((line, index) => index >= start && line.startsWith('('));
	return first < 0 ? code : code.slice(first);
}

/** The lines without the blank lines at the start and the end. */
function trimmed(lines: readonly string[]): readonly string[] {
	const start = lines.findIndex((line) => line.trim() !== '');
	const end = lastIndex(lines, lines.length, (line) => line.trim() !== '');
	return start < 0 ? [] : lines.slice(start, end + 1);
}

/** The index of the last line before `end` that matches, or -1. */
function lastIndex(lines: readonly string[], end: number, matches: (line: string) => boolean): number {
	for (let index = end - 1; index >= 0; index--) {
		if (matches(lines[index])) {
			return index;
		}
	}
	return -1;
}
