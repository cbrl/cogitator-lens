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
import type { RenderedTextArtifact } from '../types/index.js';
import { documentationForOpcode } from './instruction-documentation.js';
import {
	artifactSemanticTokenTypes,
	classifyArtifactLine,
	listingSyntaxFor,
} from '../artifacts/core/listing-syntax.js';

type ArtifactLookup = (uri: Uri) => RenderedTextArtifact | undefined;

export const artifactSemanticTokensLegend = new SemanticTokensLegend([...artifactSemanticTokenTypes]);

export class ArtifactSemanticTokensProvider implements DocumentSemanticTokensProvider {
	constructor(private readonly artifactLookup: ArtifactLookup) {}

	provideDocumentSemanticTokens(document: TextDocument, _token: CancellationToken): ProviderResult<SemanticTokens> {
		const artifact = this.artifactLookup(document.uri);
		const syntax = artifact && listingSyntaxFor(artifact);
		if (!artifact || !syntax) {
			return new SemanticTokensBuilder(artifactSemanticTokensLegend).build();
		}
		const builder = new SemanticTokensBuilder(artifactSemanticTokensLegend);
		artifact.lines.forEach((line, lineNumber) => {
			for (const token of classifyArtifactLine(line.text, syntax, {
				isDocumentedOpcode: (candidate) => documentationForOpcode(artifact, candidate) !== undefined,
			})) {
				builder.push(lineNumber, token.start, token.length, artifactSemanticTokenTypes.indexOf(token.type), 0);
			}
		});
		return builder.build();
	}
}
