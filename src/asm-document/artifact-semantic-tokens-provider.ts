import {
	SemanticTokens,
	SemanticTokensBuilder,
	SemanticTokensLegend,
	type CancellationToken,
	type DocumentSemanticTokensProvider,
	type ProviderResult,
	type TextDocument,
	type Uri,
} from 'vscode';
import type { ArtifactKind, RenderedTextArtifact } from '../types/index.js';

type ArtifactLookup = (uri: Uri) => RenderedTextArtifact | undefined;

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

export const artifactSemanticTokensLegend = new SemanticTokensLegend(
	[...artifactSemanticTokenTypes],
);

interface LineToken {
	readonly start: number;
	readonly length: number;
	readonly type: typeof artifactSemanticTokenTypes[number];
	readonly priority: number;
}

const llvmKeywords = new Set([
	'add', 'alloca', 'and', 'ashr', 'atomicrmw', 'bitcast', 'br', 'call', 'catchpad',
	'catchret', 'catchswitch', 'cleanupret', 'cleanuppad', 'cmpxchg', 'define', 'declare',
	'extractelement', 'extractvalue', 'fadd', 'fcmp', 'fdiv', 'fmul', 'fneg', 'fpext',
	'fptosi', 'fptoui', 'fptrunc', 'frem', 'fsub', 'getelementptr', 'global', 'icmp',
	'indirectbr', 'insertelement', 'insertvalue', 'invoke', 'landingpad', 'load', 'lshr',
	'mul', 'or', 'phi', 'ptrtoint', 'resume', 'ret', 'sdiv', 'select', 'sext', 'shl',
	'shufflevector', 'sitofp', 'srem', 'store', 'sub', 'switch', 'trunc', 'udiv',
	'uitofp', 'unreachable', 'urem', 'va_arg', 'xor', 'zext',
]);

/** Classifies a rendered line without reparsing compiler output or changing document text. */
export function classifyArtifactLine(text: string, kind: ArtifactKind): readonly LineToken[] {
	const candidates: LineToken[] = [];
	const addMatches = (
		re: RegExp,
		type: LineToken['type'],
		priority: number,
		filter?: (value: string) => boolean,
	) => {
		for (const match of text.matchAll(re)) {
			const value = match[0];
			if (match.index !== undefined && (!filter || filter(value))) {
				candidates.push({ start: match.index, length: value.length, type, priority });
			}
		}
	};

	const isLlvm = kind === 'llvm-ir';
	const commentStart = isLlvm ? text.indexOf(';') : assemblyCommentStart(text);
	if (commentStart >= 0) {
		candidates.push({
			start: commentStart,
			length: text.length - commentStart,
			type: 'comment',
			priority: 100,
		});
	}
	addMatches(/"(?:\\.|[^"\\])*"/g, 'string', 90);
	addMatches(/\b(?:0x[\da-f]+|\d+(?:\.\d+)?)\b/gi, 'number', 40);

	if (isLlvm) {
		addMatches(/[%@][-a-zA-Z$._\d]+/g, 'variable', 60);
		addMatches(/\b(?:i\d+|half|bfloat|float|double|fp128|x86_fp80|ptr|void|label|metadata|token)\b/g, 'type', 55);
		addMatches(/\b[a-z][a-z\d_]*\b/gi, 'keyword', 45, value => llvmKeywords.has(value));
		addMatches(/^\s*[-a-zA-Z$._\d]+(?=:)/g, 'label', 70);
	} else {
		addMatches(/^\s*[.$_a-zA-Z][\w.$@?]*(?=:)/g, 'label', 70);
		addMatches(/^\s*\.[a-zA-Z][\w.]*/g, 'keyword', 65);
		const mnemonic = /^\s*(?:[a-zA-Z][\w.]*:\s*)?([a-zA-Z][\w.]*)/.exec(text);
		if (mnemonic?.index !== undefined) {
			const start = text.indexOf(mnemonic[1], mnemonic.index);
			candidates.push({ start, length: mnemonic[1].length, type: 'keyword', priority: 65 });
		}
		addMatches(/(?:%|\$)?\b(?:r(?:1[0-5]|[0-9])[bwd]?|[re]?(?:ax|bx|cx|dx|si|di|sp|bp)|[xyz]mm\d+|x\d+|w\d+|sp|lr|pc)\b/gi, 'variable', 55);
	}
	addMatches(/(?:<<|>>|[-+*/&|^~=<>!]+)/g, 'operator', 20);

	const accepted: LineToken[] = [];
	for (const candidate of candidates.sort((left, right) =>
		right.priority - left.priority || left.start - right.start)) {
		if (!accepted.some(token =>
			token.start < candidate.start + candidate.length
			&& candidate.start < token.start + token.length)) {
			accepted.push(candidate);
		}
	}
	return accepted.sort((left, right) => left.start - right.start);
}

export class ArtifactSemanticTokensProvider implements DocumentSemanticTokensProvider {
	constructor(private readonly artifactLookup: ArtifactLookup) {}

	provideDocumentSemanticTokens(
		document: TextDocument,
		_token: CancellationToken,
	): ProviderResult<SemanticTokens> {
		const artifact = this.artifactLookup(document.uri);
		if (!artifact || !['assembly', 'binary-disassembly', 'llvm-ir'].includes(artifact.kind)) {
			return new SemanticTokensBuilder(artifactSemanticTokensLegend).build();
		}
		const builder = new SemanticTokensBuilder(artifactSemanticTokensLegend);
		artifact.lines.forEach((line, lineNumber) => {
			for (const token of classifyArtifactLine(line.text, artifact.kind)) {
				builder.push(
					lineNumber,
					token.start,
					token.length,
					artifactSemanticTokenTypes.indexOf(token.type),
					0,
				);
			}
		});
		return builder.build();
	}
}

function assemblyCommentStart(text: string): number {
	const semicolon = text.indexOf(';');
	const slash = text.indexOf('//');
	const values = [semicolon, slash].filter(value => value >= 0);
	return values.length > 0 ? Math.min(...values) : -1;
}
