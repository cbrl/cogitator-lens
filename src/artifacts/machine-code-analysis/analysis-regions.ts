import type { TargetArchitecture } from '../../types/index.js';

/** The source line of one instruction, as the debug line directives of the assembly give it. */
export interface AnalysisSource {
	readonly file: string;
	readonly line: number;
}

/** One function of the assembly, and the source of each of its instructions, in their order. */
export interface AnalysisRegion {
	readonly name: string;
	readonly sources: readonly (AnalysisSource | null)[];
}

/** Assembly that llvm-mca reads, with one code region for each function. */
export interface MarkedAssembly {
	readonly text: string;
	readonly regions: readonly AnalysisRegion[];
}

/** A label at the start of a line: a plain name or a quoted name, such as an MSVC name. */
const labelLine = /^\s*("(?:[^"\\]|\\.)+"|[A-Za-z_.$?@][\w.$?@]*):/u;
/** An ELF function symbol: `.type name,@function` or `.type name,%function`. */
const elfFunctionType = /^\s*\.type\s+("(?:[^"\\]|\\.)+"|[^\s,]+)\s*,\s*[@%]function\b/u;
/** A COFF symbol definition. `.type 32` in the same definition makes it a function. */
const coffDefinition = /^\s*\.def\s+("(?:[^"\\]|\\.)+"|[^\s;]+)\s*;/u;
const coffFunctionType = /\.type\s+32\s*;/u;
/** A directive that follows the label of a function on a target without symbol types. */
const procedureStart = /^\s*\.(?:cfi_startproc|seh_proc)\b/u;
/** A line after which no instruction belongs to the function before it. */
const functionEnd = /^\s*(?:\.(?:section|text|data|bss|cfi_endproc|seh_endproc|size)\b|#\s*-- End function)/u;
/** Debug line directives: DWARF `.file` and `.loc`, and CodeView `.cv_file` and `.cv_loc`. */
const dwarfFile = /^\s*\.file\s+(\d+)\s+("(?:[^"\\]|\\.)*")(?:\s+("(?:[^"\\]|\\.)*"))?/u;
const dwarfLocation = /^\s*\.loc\s+(\d+)\s+(\d+)/u;
const codeViewFile = /^\s*\.cv_file\s+(\d+)\s+("(?:[^"\\]|\\.)*")/u;
const codeViewLocation = /^\s*\.cv_loc\s+\d+\s+(\d+)\s+(\d+)/u;
const debugLineDirective = /^\s*\.(?:loc|file|cv_loc|cv_file|cv_func_id|cv_inline_site_id|cv_linetable|cv_fpo_\w+)\b/u;

/** The comment that starts a code region marker. llvm-mca reads the markers in comments only. */
function commentPrefix(architecture: TargetArchitecture | undefined): string {
	switch (architecture) {
		case 'aarch64':
			return '//';
		case 'arm32':
			return '@';
		default:
			return '#';
	}
}

/** The first line after a line that is not empty and not a comment. */
function nextCodeLine(lines: readonly string[], index: number): string {
	for (let next = index + 1; next < lines.length; next++) {
		const text = lines[next].trim();
		if (text && !text.startsWith('#')) {
			return lines[next];
		}
	}
	return '';
}

function unquote(name: string): string {
	return name.startsWith('"') && name.endsWith('"') ? name.slice(1, -1).replace(/\\(.)/gu, '$1') : name;
}

/** Whether a line is an instruction: not empty, not a label, not a directive, and not a comment. */
function isInstruction(line: string): boolean {
	const text = line.trim();
	return text.length > 0 && !labelLine.test(line) && !/^(?:\.|#|\/\/|;|@)/u.test(text);
}

/**
 * Marks each function of compiler assembly as an llvm-mca code region. A region holds only the
 * instructions of its function, so llvm-mca analyzes each function on its own. Without regions,
 * llvm-mca analyzes all instructions of the file as one block.
 *
 * The result also keeps the source line of each instruction of each region, from the debug line
 * directives. llvm-mca lists the instructions of a region in their order, so the renderer maps its
 * rows to source lines. The debug line directives do not go to llvm-mca: an unknown file number
 * stops it. The other changes follow the llvm-mca tool of Compiler Explorer.
 */
export function markAnalysisRegions(
	assembly: string,
	architecture: TargetArchitecture | undefined,
	resolveFile: (path: string) => string = (path) => path,
): MarkedAssembly {
	const lines = assembly.split(/\r?\n/u);
	const prefix = commentPrefix(architecture);
	const functionNames = new Set<string>();
	let definition: string | undefined;
	for (const line of lines) {
		const elf = elfFunctionType.exec(line);
		if (elf) {
			functionNames.add(unquote(elf[1]));
		}
		const coff = coffDefinition.exec(line);
		if (coff) {
			definition = unquote(coff[1]);
		}
		if (definition !== undefined && coffFunctionType.test(line)) {
			functionNames.add(definition);
		}
		if (/\.endef\b/u.test(line)) {
			definition = undefined;
		}
	}

	const files = new Map<string, string>();
	const regions: { name: string; sources: (AnalysisSource | null)[] }[] = [];
	const output: string[] = [];
	let location: AnalysisSource | null = null;
	let current: string | undefined;
	let open: (typeof regions)[number] | undefined;
	const close = (): void => {
		if (open) {
			output.push(`${prefix} LLVM-MCA-END ${open.name}`);
			open = undefined;
		}
	};
	lines.forEach((line, index) => {
		const file = dwarfFile.exec(line) ?? codeViewFile.exec(line);
		if (file) {
			const first = unquote(file[2]);
			const second = file[3] === undefined ? undefined : unquote(file[3]);
			const joined =
				second === undefined || /^(?:\/|[A-Za-z]:[\\/])/u.test(second)
					? (second ?? first)
					: `${first}/${second}`;
			files.set(file[1], resolveFile(joined));
		}
		const position = dwarfLocation.exec(line) ?? codeViewLocation.exec(line);
		if (position) {
			const path = files.get(position[1]);
			const lineNumber = Number(position[2]);
			location = path !== undefined && lineNumber > 0 ? { file: path, line: lineNumber } : null;
		}
		if (debugLineDirective.test(line)) {
			return;
		}
		const label = labelLine.exec(line);
		if (label) {
			const name = unquote(label[1]);
			// Mach-O assembly has no symbol types, so a function is a label before the unwind directive.
			const isFunction =
				functionNames.has(name) ||
				(functionNames.size === 0 && procedureStart.test(nextCodeLine(lines, index)));
			if (isFunction) {
				close();
				current = name;
				location = null;
			}
		} else if (functionEnd.test(line)) {
			close();
			current = undefined;
		} else if (current !== undefined && isInstruction(line)) {
			if (!open) {
				open = { name: current, sources: [] };
				regions.push(open);
				output.push(`${prefix} LLVM-MCA-BEGIN ${current}`);
			}
			open.sources.push(location);
		}
		output.push(rewriteForAnalysis(line));
	});
	close();
	return { text: output.join('\n'), regions };
}

/** The changes of the llvm-mca tool of Compiler Explorer, for directives that llvm-mca cannot read. */
function rewriteForAnalysis(line: string): string {
	return line
		.replace(/\.hword\s/giu, '.short ')
		.replace(/offset flat:/giu, '')
		.replace(/ptr\s%fs/giu, 'PTR fs')
		.replace(/^\s*\.(?:fnstart|eabi_attribute|fpu)\b.*/iu, '');
}
