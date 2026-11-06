import type { ArtifactLink, RenderedArtifact, RenderedArtifactLine, RenderedTextArtifact } from '../../types/index.js';

/** How a text artifact document shows its listing. */
export interface ArtifactViewOptions {
	/** Renumbers local labels and hides addresses, so two listings compare by their instructions. */
	readonly normalized?: boolean;
	/** Shows only the lines of the function with this symbol name. */
	readonly functionName?: string;
}

/** The lines of one function in a listing. Both line numbers are zero-based and inclusive. */
export interface FunctionRange {
	readonly name: string;
	readonly startLine: number;
	readonly endLine: number;
}

/** Applies the view of a document to its artifact. A graph artifact has no views. */
export function applyArtifactView(artifact: RenderedArtifact, view: ArtifactViewOptions | undefined): RenderedArtifact {
	if (artifact.presentation !== 'text' || !view) {
		return artifact;
	}
	let result = artifact;
	if (view.functionName !== undefined) {
		result = functionListing(result, view.functionName);
	}
	if (view.normalized) {
		result = normalizedListing(result);
	}
	return result;
}

/** The ranges of each listing. A listing does not change, so its ranges stay valid. */
const rangeCache = new WeakMap<RenderedTextArtifact, readonly FunctionRange[]>();

/**
 * The line range of each function symbol. A fold that starts on the symbol line gives the end.
 * Otherwise the function ends before the next symbol, without the blank lines before it.
 */
export function functionRanges(artifact: RenderedTextArtifact): readonly FunctionRange[] {
	const cached = rangeCache.get(artifact);
	if (cached) {
		return cached;
	}
	const symbols = [...artifact.symbols]
		.filter((symbol) => symbol.line >= 0 && symbol.line < artifact.lines.length)
		.sort((left, right) => left.line - right.line);
	const foldEnds = new Map(artifact.folds.map((fold) => [fold.startLine, fold.endLine]));
	// Go from the last symbol to the first, so each symbol knows the next line with another symbol.
	const ranges: FunctionRange[] = [];
	let nextLine = artifact.lines.length;
	for (let index = symbols.length - 1; index >= 0; index--) {
		const symbol = symbols[index];
		if (index < symbols.length - 1 && symbols[index + 1].line > symbol.line) {
			nextLine = symbols[index + 1].line;
		}
		let endLine = Math.min(foldEnds.get(symbol.line) ?? nextLine - 1, artifact.lines.length - 1);
		while (endLine > symbol.line && !artifact.lines[endLine].text.trim()) {
			endLine--;
		}
		ranges.push({ name: symbol.name, startLine: symbol.line, endLine });
	}
	const result = Object.freeze(ranges.reverse());
	rangeCache.set(artifact, result);
	return result;
}

/**
 * The plain name of a function symbol, so one function matches across compilers. It removes MSVC
 * and Itanium mangling, a parameter list, template arguments, namespaces, a Rust hash, and a GCC
 * clone suffix, such as `.cold`. The result is for comparison only.
 */
export function functionBaseName(symbol: string): string {
	const name = symbol.replace(/^@/, '').replace(/^"(.*)"$/, '$1');
	const msvc = /^\?+([^@?]+)@/.exec(name);
	if (msvc) {
		return msvc[1];
	}
	const itanium = /^_{1,2}Z(N[rVKO]*)?/.exec(name);
	if (itanium) {
		// The last length-prefixed part of a nested name is the function name.
		let position = itanium[0].length;
		let last: string | undefined;
		for (let length = /^\d+/.exec(name.slice(position)); length; length = /^\d+/.exec(name.slice(position))) {
			position += length[0].length;
			last = name.slice(position, position + Number(length[0]));
			position += Number(length[0]);
			if (!itanium[1]) {
				break;
			}
		}
		if (last) {
			return last;
		}
	}
	let plain = name.replace(/\(anonymous namespace\)/g, '');
	const parameters = plain.indexOf('(');
	if (parameters > 0) {
		plain = plain.slice(0, parameters);
	}
	for (let previous = ''; previous !== plain;) {
		previous = plain;
		plain = plain.replace(/<[^<>]*>/g, '');
	}
	plain = plain.replace(/::h[0-9a-f]{16}$/, '');
	// A demangled MSVC name starts with its return type and calling convention.
	const last = plain.split('::').at(-1)?.trim().split(/\s+/).at(-1) ?? plain;
	return last.replace(/^([^.]+)\..+$/, '$1') || symbol;
}

/**
 * The functions of a listing that can be the given function. An equal name is the best match.
 * Otherwise the base names must be equal, and a leading underscore of Mach-O names does not count.
 */
export function matchingFunctions(name: string, ranges: readonly FunctionRange[]): FunctionRange[] {
	const equal = ranges.filter((range) => range.name === name);
	if (equal.length > 0) {
		return equal;
	}
	const base = functionBaseName(name);
	return ranges.filter((range) => {
		const candidate = functionBaseName(range.name);
		return candidate === base || candidate === `_${base}` || `_${candidate}` === base;
	});
}

/** The lines of one function. A link or a fold that leaves the function is removed. */
export function functionListing(artifact: RenderedTextArtifact, name: string): RenderedTextArtifact {
	const range = functionRanges(artifact).find((candidate) => candidate.name === name);
	if (!range) {
		return {
			...artifact,
			lines: [{ text: `The function "${name}" is not in this listing.` }],
			links: [],
			folds: [],
			symbols: [],
			metrics: {},
		};
	}
	const { startLine, endLine } = range;
	const inside = (line: number): boolean => line >= startLine && line <= endLine;
	return {
		...artifact,
		lines: artifact.lines.slice(startLine, endLine + 1),
		links: artifact.links
			.filter((link) => inside(link.line) && inside(link.targetLine))
			.map((link) => ({ ...link, line: link.line - startLine, targetLine: link.targetLine - startLine })),
		folds: artifact.folds
			.filter((fold) => inside(fold.startLine) && inside(fold.endLine))
			.map((fold) => ({ startLine: fold.startLine - startLine, endLine: fold.endLine - startLine })),
		symbols: artifact.symbols
			.filter((symbol) => inside(symbol.line))
			.map((symbol) => ({ ...symbol, line: symbol.line - startLine })),
		// The metrics count the full listing, so they do not apply to one function.
		metrics: {},
	};
}

/**
 * Local labels, such as `.LBB0_3`, `.L3`, `LBB0_3`, `.Ltmp1`, and `$LN3@main`, and the numbered
 * LLVM IR values and metadata, such as `%5` and `!12`. The prefix stays, and the number changes.
 */
const localName =
	/(?<![\w.$%!])(\.L[A-Za-z_]*|L(?:BB|tmp|CPI|JTI)|\$L[A-Z]*|%|!)(\d+(?:_\d+)?)((?:@[\w?$@]+)?)(?![\w.])/g;
/** An address before a symbol name, such as `401020 <main+0x10>` in objdump output. */
const symbolAddress = /\b(?:0x)?[0-9a-fA-F]{4,}(?=\s+<)/g;
/** The offset in a symbol reference, such as `+0x10` in `<main+0x10>`. */
const symbolOffset = /(<[^>+]+)\+0x[0-9a-fA-F]+>/g;

interface Replacement {
	readonly start: number;
	readonly end: number;
	readonly text: string;
}

/**
 * The scope of a local name. A name has one number in its scope, so each use matches its definition.
 * - LLVM IR metadata, such as `!12`, and GCC constants, such as `.LC0`, belong to the module. Their
 *   definitions are outside the functions that use them.
 * - A name with a function number, such as `.LBB0_3` or `.LCPI0_0`, belongs to that function. Clang
 *   writes a constant pool before the label of its function.
 * - A name with a function suffix, such as `$LN3@main`, belongs to that function.
 * - Each other name belongs to the function that holds the line.
 */
function nameScope(prefix: string, number: string, suffix: string, functionIndex: number): string {
	if (prefix === '!' || prefix === '.LC') {
		return 'module';
	}
	if (suffix) {
		return `suffix ${suffix}`;
	}
	const separator = number.indexOf('_');
	return separator >= 0 ? `number ${number.slice(0, separator)}` : `function ${functionIndex}`;
}

/**
 * Renumbers local labels and numbered values in their order of use, and hides addresses. The
 * numbers of each function start again, so a change in one function does not renumber the others.
 * Module names are the exception. The line count stays the same, so the line mapping to the source
 * stays correct.
 */
export function normalizedListing(artifact: RenderedTextArtifact): RenderedTextArtifact {
	const functionStarts = new Set(artifact.symbols.map((symbol) => symbol.line));
	let functionIndex = 0;
	const numbers = new Map<string, number>();
	const counters = new Map<string, number>();
	const columnMaps: Array<((column: number) => number) | undefined> = [];
	const lines = artifact.lines.map((line, index): RenderedArtifactLine => {
		if (functionStarts.has(index)) {
			functionIndex++;
		}
		const replacements = lineReplacements(line.text, (prefix, number, suffix) => {
			const scope = `${nameScope(prefix, number, suffix, functionIndex)}\0${prefix}`;
			const key = `${scope}\0${number}`;
			let value = numbers.get(key);
			if (value === undefined) {
				value = (counters.get(scope) ?? 0) + 1;
				counters.set(scope, value);
				numbers.set(key, value);
			}
			return value;
		});
		if (replacements.length === 0) {
			return line;
		}
		columnMaps[index] = (column) => mapColumn(column, replacements);
		return { ...line, text: applyReplacements(line.text, replacements) };
	});
	return {
		...artifact,
		lines,
		links: artifact.links.map((link): ArtifactLink => {
			const map = columnMaps[link.line];
			return map
				? { ...link, startCharacter: map(link.startCharacter), endCharacter: map(link.endCharacter) }
				: link;
		}),
	};
}

function lineReplacements(
	text: string,
	numberFor: (prefix: string, number: string, suffix: string) => number,
): Replacement[] {
	const replacements: Replacement[] = [];
	for (const match of text.matchAll(localName)) {
		const [whole, prefix, number, suffix] = match;
		replacements.push({
			start: match.index,
			end: match.index + whole.length,
			text: `${prefix}#${numberFor(prefix, number, suffix)}${suffix}`,
		});
	}
	for (const match of text.matchAll(symbolAddress)) {
		replacements.push({ start: match.index, end: match.index + match[0].length, text: 'ADDR' });
	}
	for (const match of text.matchAll(symbolOffset)) {
		const start = match.index + match[1].length;
		replacements.push({ start, end: match.index + match[0].length, text: '+OFF>' });
	}
	// Overlaps cannot occur in practice. Keep the first replacement when they do.
	return replacements
		.sort((left, right) => left.start - right.start)
		.filter((replacement, index, sorted) => index === 0 || replacement.start >= sorted[index - 1].end);
}

function applyReplacements(text: string, replacements: readonly Replacement[]): string {
	let result = '';
	let position = 0;
	for (const replacement of replacements) {
		result += text.slice(position, replacement.start) + replacement.text;
		position = replacement.end;
	}
	return result + text.slice(position);
}

/** The new column of an old column. A column inside a replaced part moves to the same edge. */
function mapColumn(column: number, replacements: readonly Replacement[]): number {
	let shift = 0;
	for (const replacement of replacements) {
		if (column <= replacement.start) {
			break;
		}
		const newEnd = replacement.start + shift + replacement.text.length;
		if (column < replacement.end) {
			return Math.min(column + shift, newEnd);
		}
		shift += replacement.text.length - (replacement.end - replacement.start);
	}
	return column + shift;
}

/** Formats listing lines with an address column and a code byte column. */
export function listingWithColumns(artifact: RenderedTextArtifact, lineNumbers: readonly number[]): string {
	const lines = lineNumbers.flatMap((index) => artifact.lines[index] ?? []);
	const addressWidth = Math.max(0, ...lines.map((line) => line.address?.toString(16).length ?? 0));
	const bytesWidth = Math.max(0, ...lines.map((line) => line.opcodes?.join(' ').length ?? 0));
	return lines
		.map((line) => {
			const address = (line.address?.toString(16) ?? '').padStart(addressWidth);
			const bytes = (line.opcodes?.join(' ') ?? '').padEnd(bytesWidth);
			return [address, bytes, line.text]
				.filter((_column, index) => (index === 0 ? addressWidth > 0 : index === 1 ? bytesWidth > 0 : true))
				.join('  ')
				.trimEnd();
		})
		.join('\n');
}
