import type { ArtifactLink, RenderedArtifactLine } from '../../types/index.js';
import { branchEdge } from '../assembly/assembly-navigation.js';
import type { InstructionType } from '../control-flow-graph/parsers/instruction-sets.js';

/**
 * A relocation at the end of an instruction: its offset, its type, and its symbol with an optional
 * addend. GNU objdump writes it there with `-r -w`, and llvm-objdump output is changed to that form.
 */
const relocation = /\s[\da-f]+:\s+[A-Za-z][A-Za-z\d]*_\w+\s+(\S+?)(?:[-+]0x[\da-f]+)?\s*$/;
/**
 * A branch target at the end of an instruction: its address, which llvm-objdump writes with `0x`,
 * and the symbol and offset that objdump adds. Normalized dumpbin output gives the address alone,
 * or the symbol of a call without an offset.
 */
const branchTarget = /\s(?:0x)?([\da-f]+)(?:\s+<(.+?)(?:\+0x([\da-f]+))?>)?\s*$/;
/** A call, which the instruction classifier counts as linear code. */
const callInstruction = /^\s*(?:call[a-z]*|bl|blx)\s/;

/**
 * Links each jump to the instruction at its target, and each call to the function it names. In
 * an object file, the bytes of a call to another function hold no target yet. Its relocation
 * names the function, so the link goes on that name. Addresses in an object count from the start
 * of each section, so they repeat, and a target address is found in the function it names.
 */
export function binaryBranchLinks(
	lines: readonly RenderedArtifactLine[],
	functionLines: ReadonlyMap<string, number>,
	classifyInstruction: (instruction: string) => InstructionType | undefined,
): ArtifactLink[] {
	const functionAt = new Map([...functionLines].map(([name, line]) => [line, name]));
	const instructions = new Map<string, Map<number, number>>();
	const functionOfLine: (string | undefined)[] = [];
	let current: string | undefined;
	lines.forEach((line, index) => {
		current = functionAt.get(index) ?? current;
		functionOfLine.push(current);
		if (current !== undefined && line.address !== undefined && line.opcodes?.length) {
			const addresses = instructions.get(current) ?? new Map<number, number>();
			instructions.set(current, addresses);
			if (!addresses.has(line.address)) {
				addresses.set(line.address, index);
			}
		}
	});

	return lines.flatMap((line, index): ArtifactLink[] => {
		if (line.address === undefined || !line.opcodes?.length) {
			return [];
		}
		const text = line.text;
		const instructionType = classifyInstruction(line.disassembly ?? text);
		const relocated = relocation.exec(text);
		if (relocated) {
			const symbol = relocated[1];
			const targetLine = functionLines.get(symbol);
			const start = relocated.index + relocated[0].lastIndexOf(symbol);
			return targetLine === undefined
				? []
				: [
						{
							line: index,
							startCharacter: start,
							endCharacter: start + symbol.length,
							targetLine,
							...branchEdge(instructionType),
						},
					];
		}
		const jump = instructionType === 'unconditional-jump' || instructionType === 'conditional-jump';
		const target = jump || callInstruction.test(text) ? branchTarget.exec(text) : null;
		if (!target) {
			return [];
		}
		const [operand, address, name, offset] = target;
		const targetLine =
			name !== undefined && offset === undefined && functionLines.has(name)
				? functionLines.get(name)
				: instructions.get(name ?? functionOfLine[index] ?? '')?.get(Number.parseInt(address, 16));
		// The operand starts after the whitespace before it.
		const start = target.index + 1;
		return targetLine === undefined
			? []
			: [
					{
						line: index,
						startCharacter: start,
						endCharacter: target.index + operand.trimEnd().length,
						targetLine,
						...branchEdge(instructionType),
					},
				];
	});
}
