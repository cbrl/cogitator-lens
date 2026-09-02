import type { RenderedTextArtifact } from '../../types/index.js';
import type { BaseAssemblyDocumentationProvider } from '../../vendor/lib/asm-docs/base.js';
import type { ArtifactListingSyntax } from './artifact-contracts.js';
import { nativeAssemblyListing } from '../assembly/native-assembly-listing.js';
import { dotNetIlListing } from '../dotnet/dotnet-il-listing.js';
import { llvmIrListing } from '../llvm-ir/llvm-ir-listing.js';
import { pythonBytecodeListing } from '../python/python-bytecode-listing.js';

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

export interface NamedProvider {
	readonly label: string;
	readonly provider: BaseAssemblyDocumentationProvider;
}

export interface ListingSyntaxDefinition {
	readonly label: string;
	readonly commentMarkers: readonly string[];
	readonly mnemonic: (text: string) => string | undefined;
	readonly documentation: NamedProvider | { readonly infer: readonly NamedProvider[] };
	readonly tokens: (text: string, context: ListingTokenContext) => readonly LineToken[];
}

/** Appends every regex match that is eligible for semantic-token classification. */
export function addMatches(
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

export const listingSyntaxes: Readonly<Record<ArtifactListingSyntax, ListingSyntaxDefinition>> = {
	'native-assembly': nativeAssemblyListing,
	'dotnet-il': dotNetIlListing,
	'python-bytecode': pythonBytecodeListing,
	'llvm-ir': llvmIrListing,
};

/** Returns the syntax declaration selected by a rendered artifact, if it has one. */
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
