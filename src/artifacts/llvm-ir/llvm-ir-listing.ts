import { LLVMDocumentationProvider } from '../../vendor/lib/asm-docs/llvm.js';
import { instructionSetLabels } from '../core/instruction-set-labels.js';
import { addMatches, type LineToken, type ListingSyntaxDefinition } from '../core/listing-syntax.js';

const llvmIrMnemonic = /^\s*(?:[%@](?:[-\w.$]+|"[^"]+")\s*=\s*)?(?:(?:musttail|notail|tail)\s+)?([a-z][\w.]*)\b/iu;

export const llvmIrListing = {
	label: 'LLVM IR',
	commentMarkers: [';'],
	mnemonic: (text) => llvmIrMnemonic.exec(text)?.[1]?.toLowerCase(),
	documentation: {
		label: instructionSetLabels.llvmIr,
		provider: new LLVMDocumentationProvider(),
	},
	tokens: (text, context) => {
		const candidates: LineToken[] = [];
		addMatches(candidates, text, /[%@][-a-zA-Z$._\d]+/g, 'variable', 60);
		addMatches(
			candidates,
			text,
			/\b(?:i\d+|half|bfloat|float|double|fp128|x86_fp80|ptr|void|label|metadata|token)\b/g,
			'type',
			55,
		);
		addMatches(candidates, text, /\b[a-z][a-z\d_]*\b/gi, 'keyword', 45, context.isDocumentedOpcode);
		addMatches(candidates, text, /^\s*[-a-zA-Z$._\d]+(?=:)/g, 'label', 70);
		return candidates;
	},
} as const satisfies ListingSyntaxDefinition;
