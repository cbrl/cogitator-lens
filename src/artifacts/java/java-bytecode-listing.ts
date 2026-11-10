import type { AssemblyInstructionInfo } from '../../vendor/types/assembly-docs.interfaces.js';
import { JavaDocumentationProvider } from '../../vendor/lib/asm-docs/java.js';
import { instructionSetLabels } from '../core/instruction-set-labels.js';
// Only types: the listing table imports this module, and the renderer imports it too.
import type { ListingSyntaxDefinition, LineToken } from '../core/listing-syntax.js';

/** An instruction of a javap code listing, such as `        13: if_icmpge     33`. */
export const javaBytecodeInstruction = /^\s*(\d+): ([a-z][a-z0-9_]*)\b/u;

const vendoredDocumentation = new JavaDocumentationProvider();

/**
 * The generator of the vendored table writes one entry for each form of a few instruction families.
 * It writes `if<cond>` and `if_icmp<cond>` only for `eq` and `ne`, and `fconst_0` and `fconst_1`
 * as one name. Each family has one section in the specification, so the other forms use its entry.
 */
const familyEntries: readonly (readonly [RegExp, string])[] = [
	[/^if(?:lt|ge|gt|le)$/u, 'ifeq'],
	[/^if_icmp(?:lt|ge|gt|le)$/u, 'if_icmpeq'],
	[/^fconst_[01]$/u, 'fconst_0, 1'],
];

/** The documentation of a JVM instruction, also for the forms that the vendored table leaves out. */
export function javaInstructionDocumentation(mnemonic: string): AssemblyInstructionInfo | null {
	const instruction = mnemonic.toLowerCase();
	const direct = vendoredDocumentation.getInstructionInformation(instruction);
	if (direct) {
		return direct;
	}
	const entry = familyEntries.find(([pattern]) => pattern.test(instruction))?.[1];
	const shared = entry ? vendoredDocumentation.getInstructionInformation(entry) : null;
	return shared && { ...shared, html: shared.html.replace(`Instruction ${entry}:`, `Instruction ${instruction}:`) };
}

function matches(text: string, expression: RegExp, type: LineToken['type'], priority: number): LineToken[] {
	return [...text.matchAll(expression)].map((match) => ({
		start: match.index ?? 0,
		length: match[0].length,
		type,
		priority,
	}));
}

const declarationKeywords =
	/\b(?:public|private|protected|static|final|abstract|synchronized|native|transient|volatile|strictfp|class|interface|enum|record|extends|implements|throws|sealed|non-sealed|permits|default|module|requires|exports|opens|uses|provides)\b/gu;

export const javaBytecodeListing = {
	label: 'JVM bytecode',
	commentMarkers: ['//'],
	mnemonic: (text) => javaBytecodeInstruction.exec(text)?.[2],
	documentation: {
		label: instructionSetLabels.javaBytecode,
		provider: { getInstructionInformation: javaInstructionDocumentation },
	},
	tokens: (text) => {
		const instruction = javaBytecodeInstruction.exec(text);
		if (!instruction) {
			return matches(text, declarationKeywords, 'keyword', 50);
		}
		const offset = text.indexOf(instruction[1]);
		const mnemonic = text.indexOf(instruction[2], offset + instruction[1].length);
		return [
			{ start: offset, length: instruction[1].length, type: 'label', priority: 70 },
			{ start: mnemonic, length: instruction[2].length, type: 'keyword', priority: 65 },
			// A constant pool index, such as `#46`.
			...matches(text, /#\d+\b/gu, 'variable', 60),
		];
	},
} as const satisfies ListingSyntaxDefinition;
