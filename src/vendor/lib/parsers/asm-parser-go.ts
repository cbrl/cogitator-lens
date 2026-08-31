// Derived from Compiler Explorer's `GolangCompiler.convertNewGoL` in
// `lib/compilers/golang.ts` (BSD 2-Clause). See `src/vendor/VENDOR.md`.

import type { ParsedAsmResult } from '../../types/asmresult/asmresult.interfaces.js';
import type { ParseFiltersAndOutputOptions } from '../../types/features/filters.interfaces.js';
import { AsmParser } from './asm-parser.js';

// Each architecture uses one of these jump prefixes in cmd/asm/internal/arch.
const jumpPattern = /^(?:j|b|cb|tb|cmpb|cmpub).*/i;
const linePattern = /^\s+(?:0[Xx]?[\dA-Za-z]+)?\s?(\d+)\s*\((.+):(\d+)\)\s*([A-Z]+)(.*)/;
const unknownPattern = /^\s+(?:0[Xx]?[\dA-Za-z]+)?\s?(\d+)\s*\(<unknown line number>\)\s*([A-Z]+)(.*)/;
const functionPattern = /TEXT\s+[".]*(\S+)\(SB\)/;
const decimalTargetPattern = /(\s+)(\d+)(\s?)$/;

/** Normalizes Go's `-S` listing into the GNU-shaped text understood by CE's parser. */
export function normalizeGoAssembly(code: string): string {
	let previousSourceLine: string | undefined;
	let currentFile: string | undefined;
	let fileNumber = 0;
	let currentFunction: string | undefined;
	const functionCollisions = new Map<string, number>();
	const labels = new Set<string>();
	const usedLabels = new Set<string>();
	const output: string[] = [];

	for (const line of code.split(/\r\n|\n|\r/u)) {
		const located = linePattern.exec(line);
		const unknown = located ? undefined : unknownPattern.exec(line);
		if (!located && !unknown) {
			continue;
		}
		const pc = (located ?? unknown)![1];
		const filename = located?.[2];
		const sourceLine = located?.[3];
		const instruction = located?.[4] ?? unknown![2];
		let operands = located?.[5] ?? unknown![3];

		const functionMatch = functionPattern.exec(line);
		if (functionMatch) {
			currentFunction = functionMatch[1].replaceAll(/[()*.]+/g, '_');
			functionCollisions.set(
				currentFunction,
				(functionCollisions.get(currentFunction) ?? -1) + 1,
			);
			output.push(`${currentFunction}:`);
		}
		if (!currentFunction) {
			continue;
		}

		const collision = functionCollisions.get(currentFunction) ?? 0;
		const suffix = collision > 0 ? `_${collision}` : '';
		const label = `${currentFunction}_pc${pc.replace(/^0{0,4}/u, '')}${suffix}:`;
		if (!labels.has(label)) {
			output.push(label);
			labels.add(label);
		}
		if (filename && filename !== currentFile) {
			fileNumber++;
			output.push(`\t.file ${fileNumber} "${filename}"`);
			currentFile = filename;
		}
		if (sourceLine && sourceLine !== previousSourceLine) {
			output.push(`\t.loc ${fileNumber} ${sourceLine} 0`);
			previousSourceLine = sourceLine;
		}

		const target = decimalTargetPattern.exec(operands);
		if (target && jumpPattern.test(instruction)) {
			const targetLabel = `${currentFunction}_pc${target[2]}${suffix}`;
			usedLabels.add(`${targetLabel}:`);
			operands = `${target[1]}${targetLabel}${target[3]}`;
		}
		output.push(`\t${instruction}${operands}`);
	}

	return output.filter(line => !line.endsWith(':') || !line.includes('_pc') || usedLabels.has(line)).join('\n');
}

/** Compiler Explorer's generic assembly parser with Go listing normalization. */
export class GoAsmParser extends AsmParser {
	override processAsm(
		asmResult: string,
		filters: ParseFiltersAndOutputOptions,
	): ParsedAsmResult {
		return super.processAsm(normalizeGoAssembly(asmResult), filters);
	}
}
