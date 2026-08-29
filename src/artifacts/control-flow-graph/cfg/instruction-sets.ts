// Derived from Compiler Explorer's `lib/cfg/instruction-sets/` (BSD 2-Clause).
// See `DERIVED.md` in this directory for the provenance and the list of changes.

/**
 * How an instruction affects control flow.
 *
 * Upstream models this as a numeric `InstructionType` enum; a string union reads
 * the same way in a `switch` and survives serialization, which matters because
 * the classification is carried into diagnostics.
 */
export type InstructionType =
	| 'unconditional-jump'
	| 'conditional-jump'
	| 'return'
	| 'linear';

/**
 * Classifies assembly instructions for one instruction set.
 *
 * The classification is textual: assembly listings are the only input, so an
 * instruction set is a bundle of patterns rather than a decoder.
 */
export class InstructionSetInfo {
	/**
	 * Whether the instruction transfers control somewhere other than the next
	 * instruction. Used to split a labelled block at each branch.
	 */
	isJump(instruction: string): boolean {
		return instruction.trim().startsWith('j')
			|| /\bb\.*(?:eq|ne|cs|hs|cc|lo|hi|ls|ge|lt|gt|le|rge|rlt)?\b/u.test(instruction)
			|| /tbnz|tbz|cbnz|cbz/u.test(instruction);
	}

	classify(instruction: string): InstructionType {
		if (instruction.includes('jmp') || instruction.includes(' b ')) {
			return 'unconditional-jump';
		}
		if (this.isJump(instruction)) {
			return 'conditional-jump';
		}
		// Upstream tests for the substring `' ret'`, which needs the mnemonic to be
		// space-indented and so misses the tab-indented form assemblers emit.
		// Matching the mnemonic covers `ret`, `retq`, and the space-indented
		// `rep ret` alike.
		return /^ret[a-z]?$/u.test(opcodeOf(instruction)) || instruction.includes(' ret')
			? 'return'
			: 'linear';
	}
}

const armConditions = `(?:${[
	'eq', 'ne', 'cs', 'hs', 'cc', 'lo', 'mi', 'pl', 'vs', 'vc',
	'hi', 'ls', 'ge', 'lt', 'gt', 'le', 'al',
].join('|')})`;

const armConditionalJumps = new RegExp(
	`\\b(?:${[
		`b\\.?${armConditions}(?:\\.w)?`,
		`bx${armConditions}`,
		`bxj${armConditions}`,
		'cbz',
		'cbnz',
		'tbz',
		'tbnz',
	].map(pattern => `(?:${pattern})`).join('|')})\\b`,
	'u',
);
const armUnconditionalJumps = new RegExp(
	`\\b(?:${['b(?:\\.w)?', 'bx', 'bxj'].map(pattern => `(?:${pattern})`).join('|')})\\b`,
	'u',
);
const armReturns = new RegExp(
	`(?:${['bx', 'ret'].map(pattern => `(?:${pattern})`).join('|')})\\b.*`
	+ String.raw`|pop\s*\{(?:r(?:\d{2,}|[4-9]),\s*)*pc\}.*`
	+ String.raw`|mov\s*pc\s*,.*`,
	'u',
);

/**
 * AArch64 and 32-bit ARM.
 *
 * Branch mnemonics collide with ordinary opcodes (`bl`, `bic`), so the opcode is
 * isolated before matching rather than searched for in the whole line.
 */
export class ArmInstructionSetInfo extends InstructionSetInfo {
	override isJump(instruction: string): boolean {
		const opcode = opcodeOf(instruction);
		return armConditionalJumps.test(opcode) || armUnconditionalJumps.test(opcode);
	}

	override classify(instruction: string): InstructionType {
		const opcode = opcodeOf(instruction);
		if (armConditionalJumps.test(opcode)) {
			return 'conditional-jump';
		}
		if (armUnconditionalJumps.test(opcode)) {
			return 'unconditional-jump';
		}
		return armReturns.test(instruction.trim().toLowerCase()) ? 'return' : 'linear';
	}
}

/** Xtensa, whose branch mnemonics all begin with `b` and jumps with `j`. */
export class XtensaInstructionSetInfo extends InstructionSetInfo {
	override isJump(instruction: string): boolean {
		const type = this.classify(instruction);
		return type === 'unconditional-jump' || type === 'conditional-jump';
	}

	override classify(instruction: string): InstructionType {
		if (/^\s*b/u.test(instruction)) {
			return 'conditional-jump';
		}
		if (/^\s*jx?/u.test(instruction)) {
			return 'unconditional-jump';
		}
		return /^\s*ret/u.test(instruction) ? 'return' : 'linear';
	}
}

/**
 * MSVC assembly listings.
 *
 * The listings are Intel syntax with tab-separated operands, so the base
 * classifier's substring tests miss them: a tab-indented `ret` does not contain
 * `' ret'`. Matching the opcode directly is both simpler and exact, because
 * MSVC emits a fixed mnemonic set rather than a target-dependent one.
 */
export class MsvcInstructionSetInfo extends InstructionSetInfo {
	override isJump(instruction: string): boolean {
		return opcodeOf(msvcInstruction(instruction)).startsWith('j');
	}

	override classify(instruction: string): InstructionType {
		const opcode = opcodeOf(msvcInstruction(instruction));
		if (opcode === 'jmp') {
			return 'unconditional-jump';
		}
		if (opcode.startsWith('j')) {
			return 'conditional-jump';
		}
		return opcode === 'ret' || opcode === 'retn' ? 'return' : 'linear';
	}
}

/**
 * Removes the address and encoded-byte columns emitted by `/FAcs`.
 *
 * A short instruction is written on one line, for example
 * `0004e c3 ret 0`. Longer encodings wrap, with their mnemonic on a byte-only
 * continuation such as `00 00 sub rsp, 144`. In either form the mnemonic is
 * the first token after the hexadecimal byte run, not the first token in the
 * listing line.
 */
function msvcInstruction(instruction: string): string {
	return instruction.replace(
		/^\s*(?:[0-9a-f]{5,16}\s+)?(?:[0-9a-f]{2}\s+)+/iu,
		'',
	);
}

/**
 * The mnemonic an instruction starts with.
 *
 * Upstream splits on a literal space; listings separate the mnemonic from its
 * operands with a tab just as often, which leaves the operands attached.
 */
function opcodeOf(instruction: string): string {
	return instruction.trim().split(/\s+/u)[0].toLowerCase();
}

/** The instruction sets a toolchain profile may name for its assembly output. */
export const instructionSets = {
	base: InstructionSetInfo,
	arm32: ArmInstructionSetInfo,
	aarch64: ArmInstructionSetInfo,
	xtensa: XtensaInstructionSetInfo,
	msvc: MsvcInstructionSetInfo,
} as const satisfies Record<string, new () => InstructionSetInfo>;

export type InstructionSetName = keyof typeof instructionSets;

export function createInstructionSetInfo(name: InstructionSetName = 'base'): InstructionSetInfo {
	return new instructionSets[name]();
}
