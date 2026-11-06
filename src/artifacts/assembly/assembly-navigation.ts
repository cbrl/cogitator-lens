import type { ArtifactLink, RenderedArtifactLine, RenderedTextArtifact } from '../../types/index.js';
import type { ParsedAsmResultLine, ParsedAsmResult } from '../../vendor/types/asmresult/asmresult.interfaces.js';
import type { InstructionType } from '../control-flow-graph/parsers/instruction-sets.js';

/**
 * A label definition line, which the vendored parser keeps even for a demangled name it cannot
 * read. LLVM follows each function label with a comment naming it, which starts with `#`, `##`,
 * `//`, or `@` depending on the target, and quotes names such as MSVC-mangled ones.
 */
const labelLine = /^("[^"]*"|\S.*?):[ \t]*(?:(?:#|\/\/|@|;).*)?$/;
/** The first line of a function in a MASM listing, which cl.exe writes. A demangled name holds spaces. */
export const masmProcedureLine = /^(\S.*?)[ \t]+PROC\b/;
/** The last line of a function in a MASM listing. The frame variables of the next function follow it. */
const masmProcedureEndLine = /^(\S.*?)[ \t]+ENDP\b/;

/** The edge kind of a link from a jump, which the artifact draws. A call has none. */
export function branchEdge(instructionType: InstructionType | undefined): Pick<ArtifactLink, 'edgeKind'> {
	return instructionType === 'unconditional-jump'
		? { edgeKind: 'unconditional' }
		: instructionType === 'conditional-jump'
			? { edgeKind: 'true' }
			: {};
}

/**
 * Adds symbol, link, and fold metadata derived from a parsed assembly listing.
 *
 * With `isFunction`, the outline and folds come from the label lines it accepts, so local and
 * data labels do not split a function and demangled names still appear. Without it, every label
 * the parser defines is treated as a function.
 */
export function withLabelNavigation(
	artifact: RenderedTextArtifact,
	parsed: ParsedAsmResult,
	classifyInstruction: (instruction: string) => InstructionType | undefined,
	isFunction?: (label: string) => boolean,
): RenderedTextArtifact {
	// The parser reports one-based line numbers and columns.
	const definitions = Object.fromEntries(
		Object.entries(parsed.labelDefinitions ?? {}).map(([name, line]) => [name, line - 1]),
	);
	const links = parsed.asm.flatMap((line, lineIndex) =>
		(line.labels ?? []).flatMap((label) => {
			const targetLine = definitions[label.target ?? label.name];
			return targetLine === undefined || targetLine < 0
				? []
				: [
						{
							line: lineIndex,
							startCharacter: label.range.startCol - 1,
							endCharacter: label.range.endCol - 1,
							targetLine,
							...branchEdge(classifyInstruction(line.disassembly ?? line.text)),
						},
					];
		}),
	);
	const symbols = (
		isFunction
			? artifact.lines.flatMap((line, index) => {
					const label = labelLine.exec(line.text)?.[1] ?? masmProcedureLine.exec(line.text)?.[1];
					const name = label === undefined ? undefined : unquote(label);
					return name !== undefined && isFunction(name) ? [{ name, line: index }] : [];
				})
			: Object.entries(definitions).map(([name, line]) => ({ name, line }))
	).sort((left, right) => left.line - right.line || left.name.localeCompare(right.name));
	const boundaryLines = [...new Set(symbols.map((symbol) => symbol.line))]
		.filter((line) => line >= 0 && line < artifact.lines.length)
		.sort((left, right) => left - right);
	const folds = boundaryLines.flatMap((startLine, index) => {
		const nextStart = boundaryLines[index + 1] ?? artifact.lines.length;
		const endLine = procedureEndLine(artifact.lines, startLine, nextStart) ?? nextStart - 1;
		return endLine > startLine ? [{ startLine, endLine }] : [];
	});
	return { ...artifact, links, folds, symbols };
}

/**
 * The `ENDP` line of a MASM procedure that starts on a line, before the next function starts. The
 * lines after it, such as `left$ = 16`, describe the frame of the next function.
 */
function procedureEndLine(
	lines: readonly RenderedArtifactLine[],
	startLine: number,
	nextStart: number,
): number | undefined {
	const name = masmProcedureLine.exec(lines[startLine].text)?.[1];
	if (name === undefined) {
		return undefined;
	}
	for (let line = startLine + 1; line < nextStart; line++) {
		if (masmProcedureEndLine.exec(lines[line].text)?.[1] === name) {
			return line;
		}
	}
	return undefined;
}

/**
 * Returns a test for function labels when the listing declares its functions: ELF `.type` and
 * COFF `.def` directives and MASM `PROC` lines name them, and Mach-O functions are the symbols
 * with a leading underscore. Returns nothing when the listing gives no way to tell.
 */
export function functionLabelTest(rawAssembly: string): ((label: string) => boolean) | undefined {
	const declared = new Set<string>();
	for (const match of rawAssembly.matchAll(new RegExp(masmProcedureLine.source, 'gm'))) {
		declared.add(match[1]);
	}
	for (const match of rawAssembly.matchAll(/^[ \t]*\.type[ \t]+(.+),[ \t]*[@%]function[ \t]*$/gm)) {
		declared.add(unquote(match[1].trim()));
	}
	// GCC writes `.def name; .scl 2; .type 32; .endef` on one line, and LLVM on four.
	for (const match of rawAssembly.matchAll(/^[ \t]*\.def[ \t]+([^;\n]+?)[ \t]*;([\s\S]*?)\.endef/gm)) {
		if (/\.type[ \t]+32\b/.test(match[2])) {
			declared.add(unquote(match[1].trim()));
		}
	}
	if (declared.size > 0) {
		return (label) => declared.has(label);
	}
	if (/^[ \t]*\.(?:subsections_via_symbols|build_version|macosx_version_min)\b/m.test(rawAssembly)) {
		return (label) => label.startsWith('_');
	}
	return undefined;
}

function unquote(name: string): string {
	return name.length > 1 && name.startsWith('"') && name.endsWith('"') ? name.slice(1, -1) : name;
}

/** Converts a compiler-explorer parser line into the extension's line type. */
export function parsedLine(line: ParsedAsmResultLine): RenderedArtifactLine {
	return {
		text: line.text,
		opcodes: line.opcodes ? [...line.opcodes] : undefined,
		address: line.address,
		disassembly: line.disassembly ?? (line.opcodes ? line.text.trimStart() : undefined),
		source: line.source
			? {
					file: line.source.file,
					line: line.source.line,
					column: line.source.column,
					mainSource: line.source.mainsource,
				}
			: line.source,
	};
}
