import type { RenderedArtifactLine, RenderedTextArtifact } from '../../types/index.js';
import type { ParsedAsmResultLine, ParsedAsmResult } from '../../vendor/types/asmresult/asmresult.interfaces.js';
import type { InstructionType } from '../control-flow-graph/parsers/instruction-sets.js';

/** A label definition line, which the vendored parser keeps even for a demangled name it cannot read. */
const labelLine = /^(\S.*):\s*$/;

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
	// The parser reports one-based line numbers.
	const definitions = Object.fromEntries(
		Object.entries(parsed.labelDefinitions ?? {}).map(([name, line]) => [name, line - 1]),
	);
	const links = parsed.asm.flatMap((line, lineIndex) =>
		(line.labels ?? []).flatMap((label) => {
			const targetLine = definitions[label.target ?? label.name];
			const instructionType = classifyInstruction(line.disassembly ?? line.text);
			const edgeKind =
				instructionType === 'unconditional-jump'
					? ('unconditional' as const)
					: instructionType === 'conditional-jump'
						? ('true' as const)
						: undefined;
			return targetLine === undefined || targetLine < 0
				? []
				: [
						{
							line: lineIndex,
							startCharacter: label.range.startCol,
							endCharacter: label.range.endCol,
							targetLine,
							...(edgeKind ? { edgeKind } : {}),
						},
					];
		}),
	);
	const symbols = (
		isFunction
			? artifact.lines.flatMap((line, index) => {
					const name = labelLine.exec(line.text)?.[1];
					return name !== undefined && isFunction(name) ? [{ name, line: index }] : [];
				})
			: Object.entries(definitions).map(([name, line]) => ({ name, line }))
	).sort((left, right) => left.line - right.line || left.name.localeCompare(right.name));
	const boundaryLines = [...new Set(symbols.map((symbol) => symbol.line))]
		.filter((line) => line >= 0 && line < artifact.lines.length)
		.sort((left, right) => left - right);
	const folds = boundaryLines.flatMap((startLine, index) => {
		const endLine = (boundaryLines[index + 1] ?? artifact.lines.length) - 1;
		return endLine > startLine ? [{ startLine, endLine }] : [];
	});
	return { ...artifact, links, folds, symbols };
}

/**
 * Returns a test for function labels when the listing declares its functions: ELF `.type` and
 * COFF `.def` directives name them, and Mach-O functions are the symbols with a leading
 * underscore. Returns nothing when the listing gives no way to tell.
 */
export function functionLabelTest(rawAssembly: string): ((label: string) => boolean) | undefined {
	const declared = new Set<string>();
	for (const match of rawAssembly.matchAll(/^[ \t]*\.type[ \t]+(.+),[ \t]*[@%]function[ \t]*$/gm)) {
		declared.add(unquote(match[1].trim()));
	}
	for (const match of rawAssembly.matchAll(/^[ \t]*\.def[ \t]+([^;]+?)[ \t]*;.*\.type[ \t]+32[ \t]*;/gm)) {
		declared.add(unquote(match[1].trim()));
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
