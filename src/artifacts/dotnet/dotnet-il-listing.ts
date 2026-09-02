import { documentationForDotNetIlOpcode } from '../../artifact-document/generated/dotnet-il-opcodes.js';
import { instructionSetLabels } from '../core/instruction-set-labels.js';
import { addMatches, type ListingSyntaxDefinition } from '../core/listing-syntax.js';
import { nativeAssemblyTokens } from '../assembly/native-assembly-listing.js';

const dotNetIlMnemonic = /^\s*(?:IL_[\da-f]+:\s+)?([a-z][\w.]*)\s/iu;

export const dotNetIlListing = {
	label: '.NET IL',
	commentMarkers: [';', '//'],
	mnemonic: (text) => dotNetIlMnemonic.exec(`${text} `)?.[1]?.toLowerCase(),
	documentation: {
		label: instructionSetLabels.dotNetIl,
		provider: {
			getInstructionInformation(instruction) {
				return documentationForDotNetIlOpcode(instruction) ?? null;
			},
		},
	},
	tokens: (text, context) => {
		const candidates = [...nativeAssemblyTokens(text, context)];
		addMatches(candidates, text, /\bIL_[\da-f]+\b/gi, 'label', 70);
		return candidates;
	},
} as const satisfies ListingSyntaxDefinition;
