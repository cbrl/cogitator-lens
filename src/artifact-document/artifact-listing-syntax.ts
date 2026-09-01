import type { ArtifactListingSyntax, RenderedTextArtifact } from '../types/index.js';

export const artifactSemanticTokenTypes = [
	'comment',
	'string',
	'number',
	'keyword',
	'operator',
	'regexp',
	'type',
	'function',
	'variable',
	'label',
] as const;

export interface LineToken {
	readonly start: number;
	readonly length: number;
	readonly type: (typeof artifactSemanticTokenTypes)[number];
	readonly priority: number;
}

export interface ListingTokenContext {
	/** True when the candidate resolves in this listing's documentation table. */
	readonly isDocumentedOpcode: (candidate: string) => boolean;
}

export interface ListingSyntaxDefinition {
	readonly label: string;
	readonly commentMarkers: readonly string[];
	readonly mnemonic: (text: string) => string | undefined;
	readonly documentationSet: 'llvm' | 'dotnet-il' | 'python' | 'infer-native';
	readonly tokens: (text: string, context: ListingTokenContext) => readonly LineToken[];
}

/** The single expression used to recognize an instruction in `python -m dis` output. */
export const pythonBytecodeInstruction = /^\s*(?:\d+\s+)?(?:(?:-->)?\s*(?:>>)?\s*)?(?:\d+\s+)?([A-Z][A-Z0-9_]*)\b/u;

const nativeAssemblyMnemonic = /^\s*(?:[.$_a-zA-Z][\w.$@?]*:\s*)?([a-zA-Z][\w.]*)/u;
const dotNetIlMnemonic = /^\s*(?:IL_[\da-f]+:\s+)?([a-z][\w.]*)\s/iu;
const llvmIrMnemonic = /^\s*(?:[%@](?:[-\w.$]+|"[^"]+")\s*=\s*)?(?:(?:musttail|notail|tail)\s+)?([a-z][\w.]*)\b/iu;

function mnemonicFrom(expression: RegExp, text: string): string | undefined {
	return expression.exec(text)?.[1]?.toLowerCase();
}

function addMatches(
	candidates: LineToken[],
	text: string,
	expression: RegExp,
	type: LineToken['type'],
	priority: number,
	filter?: (value: string) => boolean,
): void {
	for (const match of text.matchAll(expression)) {
		const value = match[0];
		if (match.index !== undefined && (!filter || filter(value))) {
			candidates.push({ start: match.index, length: value.length, type, priority });
		}
	}
}

function nativeAssemblyTokens(text: string, context: ListingTokenContext): readonly LineToken[] {
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

export const listingSyntaxes: Readonly<Record<ArtifactListingSyntax, ListingSyntaxDefinition>> = {
	'native-assembly': {
		label: 'Native assembly',
		commentMarkers: [';', '//'],
		mnemonic: (text) => mnemonicFrom(nativeAssemblyMnemonic, text),
		documentationSet: 'infer-native',
		tokens: nativeAssemblyTokens,
	},
	'dotnet-il': {
		label: '.NET IL',
		commentMarkers: [';', '//'],
		mnemonic: (text) => mnemonicFrom(dotNetIlMnemonic, `${text} `),
		documentationSet: 'dotnet-il',
		tokens: (text, context) => {
			const candidates = [...nativeAssemblyTokens(text, context)];
			addMatches(candidates, text, /\bIL_[\da-f]+\b/gi, 'label', 70);
			return candidates;
		},
	},
	'python-bytecode': {
		label: 'Python bytecode',
		commentMarkers: [],
		mnemonic: (text) => mnemonicFrom(pythonBytecodeInstruction, text),
		documentationSet: 'python',
		tokens: (text) => {
			const mnemonic = pythonBytecodeInstruction.exec(text);
			if (!mnemonic) {
				return [];
			}
			const start = text.indexOf(mnemonic[1]);
			return [{ start, length: mnemonic[1].length, type: 'keyword', priority: 65 }];
		},
	},
	'llvm-ir': {
		label: 'LLVM IR',
		commentMarkers: [';'],
		mnemonic: (text) => mnemonicFrom(llvmIrMnemonic, text),
		documentationSet: 'llvm',
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
	},
};

export function listingSyntaxFor(artifact: RenderedTextArtifact): ListingSyntaxDefinition | undefined {
	return artifact.listingSyntax ? listingSyntaxes[artifact.listingSyntax] : undefined;
}

/** Classifies a rendered line without reparsing compiler output or changing document text. */
export function classifyArtifactLine(
	text: string,
	syntax: ListingSyntaxDefinition,
	context: ListingTokenContext,
): readonly LineToken[] {
	const candidates: LineToken[] = [];
	const commentStarts = syntax.commentMarkers.map((marker) => text.indexOf(marker)).filter((start) => start >= 0);
	const commentStart = commentStarts.length > 0 ? Math.min(...commentStarts) : -1;
	if (commentStart >= 0) {
		candidates.push({ start: commentStart, length: text.length - commentStart, type: 'comment', priority: 100 });
	}
	addMatches(candidates, text, /"(?:\\.|[^"\\])*"/g, 'string', 90);
	addMatches(candidates, text, /\b(?:0x[\da-f]+|\d+(?:\.\d+)?)\b/gi, 'number', 40);
	candidates.push(...syntax.tokens(text, context));
	addMatches(candidates, text, /(?:<<|>>|[-+*/&|^~=<>!]+)/g, 'operator', 20);

	const accepted: LineToken[] = [];
	for (const candidate of candidates.sort(
		(left, right) => right.priority - left.priority || left.start - right.start,
	)) {
		if (
			!accepted.some(
				(token) =>
					token.start < candidate.start + candidate.length && candidate.start < token.start + token.length,
			)
		) {
			accepted.push(candidate);
		}
	}
	return accepted.sort((left, right) => left.start - right.start);
}
