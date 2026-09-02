import type { RenderedTextArtifact } from '../types/index.js';
import type { AssemblyInstructionInfo } from '../vendor/types/assembly-docs.interfaces.js';
import { instructionSetLabels } from '../artifacts/core/instruction-set-labels.js';
import { listingSyntaxFor, type NamedProvider } from '../artifacts/core/listing-syntax.js';

export { instructionSetLabels };

export interface InstructionDocumentation {
	readonly mnemonic: string;
	readonly instructionSet: string;
	readonly tooltip: string;
	readonly url: string;
}

const inferredProviders = new WeakMap<RenderedTextArtifact, NamedProvider>();

/**
 * Looks up documentation emitted by Compiler Explorer's docenizers.
 *
 * The rendered artifact's listing syntax selects its documentation set. Native
 * assembly target architecture is not currently part of a compilation profile,
 * so it is inferred once per rendered listing by scoring its distinct mnemonics
 * against each documentation set.
 */
export function documentationForInstruction(
	artifact: RenderedTextArtifact,
	text: string,
): InstructionDocumentation | undefined {
	const mnemonic = instructionMnemonic(artifact, text);
	if (!mnemonic) {
		return undefined;
	}
	return documentationForOpcode(artifact, mnemonic);
}

/** Looks up an opcode directly in the docenizer-generated instruction table. */
export function documentationForOpcode(
	artifact: RenderedTextArtifact,
	mnemonic: string,
): InstructionDocumentation | undefined {
	const providerDeclaration = listingSyntaxFor(artifact)?.documentation;
	if (!providerDeclaration) {
		return undefined;
	}
	let namedProvider: NamedProvider;
	if ('infer' in providerDeclaration) {
		const cached = inferredProviders.get(artifact);
		namedProvider = cached ?? inferAssemblyProvider(artifact, providerDeclaration.infer);
		if (!cached) {
			inferredProviders.set(artifact, namedProvider);
		}
	} else {
		namedProvider = providerDeclaration;
	}
	const information = namedProvider.provider.getInstructionInformation(mnemonic);
	return information ? documentation(mnemonic, namedProvider, information) : undefined;
}

export function instructionMnemonic(artifact: RenderedTextArtifact, text: string): string | undefined {
	return listingSyntaxFor(artifact)?.mnemonic(text);
}

/** Selects the documentation provider covering the most mnemonics in an assembly artifact. */
function inferAssemblyProvider(artifact: RenderedTextArtifact, providers: readonly NamedProvider[]): NamedProvider {
	const mnemonics = new Set<string>();
	for (const line of artifact.lines) {
		const mnemonic = instructionMnemonic(artifact, line.disassembly ?? line.text);
		if (mnemonic) {
			mnemonics.add(mnemonic);
		}
		if (mnemonics.size >= 256) {
			break;
		}
	}

	const scores = providers.map(() => 0);
	for (const mnemonic of mnemonics) {
		const matches = providers
			.map((candidate, index) => (candidate.provider.getInstructionInformation(mnemonic) ? index : -1))
			.filter((index) => index >= 0);
		for (const index of matches) {
			// An opcode present in one set is stronger evidence than ADD/MOV-style
			// mnemonics shared by several architectures.
			scores[index] += 1 / matches.length;
		}
	}
	let bestIndex = 0;
	for (let index = 1; index < scores.length; index++) {
		if (scores[index] > scores[bestIndex]) {
			bestIndex = index;
		}
	}
	return providers[bestIndex];
}

function documentation(
	mnemonic: string,
	provider: NamedProvider,
	information: AssemblyInstructionInfo,
): InstructionDocumentation {
	return {
		mnemonic,
		instructionSet: provider.label,
		tooltip: information.tooltip.trim(),
		url: information.url,
	};
}
