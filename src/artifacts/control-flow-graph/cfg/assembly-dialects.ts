// Derived from Compiler Explorer's `lib/cfg/cfg-parsers/{gcc,clang,vc}.ts`
// (BSD 2-Clause). See `DERIVED.md` for the provenance and the list of changes.

import { AssemblyCfgParser, type Range } from './assembly-cfg-parser.js';
import type { AssemblyLine } from './assembly-line.js';
import { InstructionSetInfo, MsvcInstructionSetInfo } from './instruction-sets.js';

/**
 * GNU assembly listings.
 *
 * GCC emits a label for every branch target it considered, including ones whose
 * body ends up holding nothing but directives. Only labels that actually own an
 * instruction are kept, so the graph has no empty blocks.
 */
export class GccAssemblyCfgParser extends AssemblyCfgParser {
	static override readonly dialect = 'gcc-asm';

	protected override filterData(assembly: readonly AssemblyLine[]): AssemblyLine[] {
		const isInstruction = (text: string) =>
			!text.startsWith('#') && !/^\s+\./u.test(text) && text.trim() !== '';
		const isFunctionName = (text: string) =>
			text.endsWith(':') && text.includes('(') && text.includes(')');

		const result: AssemblyLine[] = [];
		let currentLabel: AssemblyLine | undefined;
		let emittedLabel = false;
		for (const line of assembly) {
			if (isFunctionName(line.text)) {
				result.push(line);
				currentLabel = line;
				emittedLabel = true;
				continue;
			}
			if (line.text.trim().endsWith(':')) {
				currentLabel = line;
				emittedLabel = false;
				continue;
			}
			if (!isInstruction(line.text)) {
				continue;
			}
			if (!emittedLabel) {
				// Upstream dereferences the pending label unconditionally; a listing
				// whose first instruction precedes any label would fail there.
				if (currentLabel) {
					result.push(currentLabel);
				}
				emittedLabel = true;
			}
			result.push(line);
		}
		return result;
	}
}

/**
 * Clang and other LLVM-backed assembly listings.
 *
 * Block labels are `.LBB<function>_<block>` rather than `.L<n>`, and trailing
 * `#`/`//` comments are annotations rather than code.
 */
export class ClangAssemblyCfgParser extends AssemblyCfgParser {
	static override readonly dialect = 'clang-asm';

	protected override filterData(assembly: readonly AssemblyLine[]): AssemblyLine[] {
		const jumpLabel = /\.LBB\d+_\d+:/u;
		return this.filterTextSection(assembly)
			.filter(line => line.text
				&& (line.source !== undefined || jumpLabel.test(line.text) || this.isFunctionName(line)))
			.map(line => ({ ...line, text: stripAssemblyComment(line.text) }))
			.filter(line => line.text.length > 0);
	}

	protected override extractJumpTarget(instruction: string): string | undefined {
		return instruction.match(/\.LBB\d+_\d+/u)?.[0].concat(':');
	}
}

/**
 * MSVC `/FAsc` assembly listings.
 *
 * Functions are delimited by `PROC`/`ENDP` rather than by labels, and block
 * labels start with `$`. `@` is part of MSVC's own decorated names, so
 * synthesised block names are separated with `#` instead.
 */
export class MsvcAssemblyCfgParser extends AssemblyCfgParser {
	static override readonly dialect = 'msvc-asm';

	constructor(instructionSet: InstructionSetInfo = new MsvcInstructionSetInfo()) {
		super(instructionSet);
	}

	protected override filterData(assembly: readonly AssemblyLine[]): AssemblyLine[] {
		const result: AssemblyLine[] = [];
		let inFunction = false;
		for (const line of assembly) {
			const text = stripMsvcComment(line.text);
			if (text.length === 0) {
				continue;
			}
			if (text.endsWith(' PROC')) {
				inFunction = true;
			}
			if (inFunction) {
				result.push({ ...line, text });
			}
			if (text.endsWith(' ENDP')) {
				inFunction = false;
			}
		}
		return result;
	}

	/**
	 * Cuts the listing at each `ENDP`, leaving the directive itself outside the
	 * function.
	 *
	 * Upstream keeps `ENDP` inside the range and then has to keep it out of its
	 * own block, which leaves it as the block's last instruction: the block that
	 * actually returns is classified from a directive rather than from its `ret`.
	 */
	protected override splitToFunctions(assembly: readonly AssemblyLine[]): Range[] {
		const result: Range[] = [];
		let start = 0;
		for (let cursor = 0; cursor < assembly.length; cursor++) {
			if (this.isFunctionEnd(assembly[cursor].text)) {
				result.push({ start, end: cursor });
				start = cursor + 1;
			}
		}
		return result.filter(range => range.end > range.start + 1);
	}

	protected override functionName(assembly: readonly AssemblyLine[], fn: Range): string {
		return assembly[fn.start].text.trim().replace(/\s+PROC$/u, '');
	}

	protected override isFunctionEnd(text: string): boolean {
		return text.endsWith('ENDP');
	}

	protected override isBasicBlockEnd(instruction: string, _previousInstruction: string): boolean {
		return instruction[0] === '$';
	}

	protected override extractJumpTarget(instruction: string): string | undefined {
		const target = /\$\S*/u.exec(instruction)?.[0];
		return target === undefined ? undefined : `${target}:`;
	}

	protected override labelSeparator(): string {
		return '#';
	}
}

function stripAssemblyComment(text: string): string {
	const x86 = text.indexOf('# ');
	const arm = text.indexOf('// ');
	let result = text;
	if (x86 !== -1) {
		result = result.slice(0, x86).trimEnd();
	}
	if (arm !== -1) {
		result = result.slice(0, arm).trimEnd();
	}
	return result;
}

function stripMsvcComment(text: string): string {
	const comment = text.indexOf(';');
	return comment === -1 ? text : text.slice(0, comment).trimEnd();
}
