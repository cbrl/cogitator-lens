import { Amd64DocumentationProvider } from '../../vendor/lib/asm-docs/amd64.js';
import { Arm32DocumentationProvider, ArmArch64DocumentationProvider } from '../../vendor/lib/asm-docs/arm.js';
import { PowerDocumentationProvider } from '../../vendor/lib/asm-docs/power.js';
import { PTXDocumentationProvider } from '../../vendor/lib/asm-docs/ptx.js';
import { Riscv64DocumentationProvider } from '../../vendor/lib/asm-docs/riscv64.js';
import { SASSDocumentationProvider } from '../../vendor/lib/asm-docs/sass.js';
import { instructionSetLabels } from '../core/instruction-set-labels.js';
import {
	addMatches,
	type InferredDocumentation,
	type LineToken,
	type ListingSyntaxDefinition,
	type ListingTokenContext,
	type NamedProvider,
} from '../core/listing-syntax.js';

/**
 * The mnemonic after an optional label and an optional guard predicate, such as `@%p1` in PTX or
 * `@!P0` in SASS.
 */
const nativeAssemblyMnemonic = /^\s*(?:[.$_a-zA-Z][\w.$@?]*:\s*)?(?:@!?%?\w+\s+)?([a-zA-Z][\w.]*)/u;

const amd64: NamedProvider = { label: instructionSetLabels.amd64, provider: new Amd64DocumentationProvider() };
const aarch64: NamedProvider = { label: instructionSetLabels.aarch64, provider: new ArmArch64DocumentationProvider() };
const arm32: NamedProvider = { label: instructionSetLabels.arm32, provider: new Arm32DocumentationProvider() };
const riscv64: NamedProvider = { label: instructionSetLabels.riscv64, provider: new Riscv64DocumentationProvider() };
const power: NamedProvider = { label: instructionSetLabels.power, provider: new PowerDocumentationProvider() };
// PTX and SASS document each instruction without its type and modifier suffixes.
const ptx: NamedProvider = {
	label: instructionSetLabels.ptx,
	provider: new PTXDocumentationProvider(),
	baseMnemonic: true,
};
const sass: NamedProvider = {
	label: instructionSetLabels.sass,
	provider: new SASSDocumentationProvider(),
	baseMnemonic: true,
};

/**
 * The target of a compile selects the documentation set. Without a target, the mnemonics select
 * one. AMD64 comes first, so a listing of mnemonics that all sets know, such as `add` and `mov`,
 * gets the usual host. POWER, PTX, and SASS share many mnemonics with the others, so only a target
 * selects them.
 */
const assemblyDocumentation: InferredDocumentation = {
	infer: [amd64, aarch64, arm32, riscv64],
	byArchitecture: { x86: amd64, aarch64, arm32, riscv64, power, ptx, sass },
};

/** Tokenizes labels, directives, mnemonics, and common register forms in native assembly. */
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
	documentation: assemblyDocumentation,
	tokens: nativeAssemblyTokens,
} as const satisfies ListingSyntaxDefinition;
