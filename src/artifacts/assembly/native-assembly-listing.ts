import { Amd64DocumentationProvider } from '../../vendor/lib/asm-docs/amd64.js';
import { Arm32DocumentationProvider, ArmArch64DocumentationProvider } from '../../vendor/lib/asm-docs/arm.js';
import { Riscv64DocumentationProvider } from '../../vendor/lib/asm-docs/riscv64.js';
import { instructionSetLabels } from '../core/instruction-set-labels.js';
import {
	addMatches,
	type LineToken,
	type ListingSyntaxDefinition,
	type ListingTokenContext,
} from '../core/listing-syntax.js';

const nativeAssemblyMnemonic = /^\s*(?:[.$_a-zA-Z][\w.$@?]*:\s*)?([a-zA-Z][\w.]*)/u;

// Put AMD64 first so a listing containing only architecture-neutral mnemonics
// gets the extension's conventional host target. Distinctive opcodes in a
// normal listing cause the generic scoring to select the actual instruction set.
const assemblyProviders = [
	{ label: instructionSetLabels.amd64, provider: new Amd64DocumentationProvider() },
	{ label: instructionSetLabels.aarch64, provider: new ArmArch64DocumentationProvider() },
	{ label: instructionSetLabels.arm32, provider: new Arm32DocumentationProvider() },
	{ label: instructionSetLabels.riscv64, provider: new Riscv64DocumentationProvider() },
] as const;

export function nativeAssemblyTokens(text: string, context: ListingTokenContext): readonly LineToken[] {
	const candidates: LineToken[] = [];
	addMatches(candidates, text, /^\s*[.$_a-zA-Z][\w.$@?]*(?=:)/g, 'label', 70);
	addMatches(candidates, text, /^\s*\.[a-zA-Z][\w.]*/g, 'keyword', 65);
	const mnemonic = nativeAssemblyMnemonic.exec(text);
	if (mnemonic?.index !== undefined && context.isDocumentedOpcode(mnemonic[1])) {
		const start = text.indexOf(mnemonic[1], mnemonic.index);
		candidates.push({ start, length: mnemonic[1].length, type: 'keyword', priority: 65 });
	}
	addMatches(
		candidates,
		text,
		/(?:%|\$)?\b(?:r(?:1[0-5]|[0-9])[bwd]?|[re]?(?:ax|bx|cx|dx|si|di|sp|bp)|[xyz]mm\d+|x\d+|w\d+|sp|lr|pc)\b/gi,
		'variable',
		55,
	);
	return candidates;
}

export const nativeAssemblyListing = {
	label: 'Native assembly',
	commentMarkers: [';', '//'],
	mnemonic: (text) => nativeAssemblyMnemonic.exec(text)?.[1]?.toLowerCase(),
	documentation: { infer: assemblyProviders },
	tokens: nativeAssemblyTokens,
} as const satisfies ListingSyntaxDefinition;
