import type { RenderedArtifactLine, RenderedTextArtifact } from '../../types/index.js';
import type { ParsedAsmResultLine, ParsedAsmResult } from '../../vendor/types/asmresult/asmresult.interfaces.js';
import type { InstructionType } from '../control-flow-graph/parsers/instruction-sets.js';

export function withLabelNavigation(
	artifact: RenderedTextArtifact,
	parsed: ParsedAsmResult,
	classifyInstruction: (instruction: string) => InstructionType | undefined,
): RenderedTextArtifact {
	const definitions = parsed.labelDefinitions ?? {};
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
			return targetLine === undefined
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
	const symbols = Object.entries(definitions)
		.map(([name, line]) => ({ name, line }))
		.sort((left, right) => left.line - right.line || left.name.localeCompare(right.name));
	const boundaryLines = [...new Set(symbols.map((symbol) => symbol.line))]
		.filter((line) => line >= 0 && line < artifact.lines.length)
		.sort((left, right) => left - right);
	const folds = boundaryLines.flatMap((startLine, index) => {
		const endLine = (boundaryLines[index + 1] ?? artifact.lines.length) - 1;
		return endLine > startLine ? [{ startLine, endLine }] : [];
	});
	return { ...artifact, links, folds, symbols };
}

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
