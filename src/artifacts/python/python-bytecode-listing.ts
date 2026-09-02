import { PythonDocumentationProvider } from '../../vendor/lib/asm-docs/python.js';
import { instructionSetLabels } from '../core/instruction-set-labels.js';
import type { ListingSyntaxDefinition } from '../core/listing-syntax.js';

/** The single expression used to recognize an instruction in `python -m dis` output. */
export const pythonBytecodeInstruction = /^\s*(?:\d+\s+)?(?:(?:-->)?\s*(?:>>)?\s*)?(?:\d+\s+)?([A-Z][A-Z0-9_]*)\b/u;

export const pythonBytecodeListing = {
	label: 'Python bytecode',
	commentMarkers: [],
	mnemonic: (text) => pythonBytecodeInstruction.exec(text)?.[1]?.toLowerCase(),
	documentation: {
		label: instructionSetLabels.pythonBytecode,
		provider: new PythonDocumentationProvider(),
	},
	tokens: (text) => {
		const mnemonic = pythonBytecodeInstruction.exec(text);
		if (!mnemonic) {
			return [];
		}
		const start = text.indexOf(mnemonic[1]);
		return [{ start, length: mnemonic[1].length, type: 'keyword', priority: 65 }];
	},
} as const satisfies ListingSyntaxDefinition;
