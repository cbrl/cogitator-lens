import path from 'path';
import {
	DocumentLink,
	DocumentLinkProvider,
	DocumentSymbol,
	DocumentSymbolProvider,
	Definition,
	DefinitionLink,
	DefinitionProvider,
	FoldingRange,
	FoldingRangeProvider,
	Hover,
	HoverProvider,
	Location,
	MarkdownString,
	Position,
	ProviderResult,
	Range,
	SymbolKind,
	TextDocument,
	Uri,
	type CancellationToken,
} from 'vscode';
import { artifactDefinitions } from '../artifacts/core/artifact-definitions.js';
import type { RenderedTextArtifact } from '../types/index.js';
import { documentationForInstruction } from './instruction-documentation.js';

type ArtifactLookup = (uri: Uri) => RenderedTextArtifact | undefined;

export class ArtifactNavigationProvider implements
	DefinitionProvider,
	DocumentLinkProvider,
	FoldingRangeProvider,
	HoverProvider,
	DocumentSymbolProvider {
	constructor(private readonly artifactLookup: ArtifactLookup) {}

	provideDefinition(
		document: TextDocument,
		position: Position,
		_token: CancellationToken,
	): ProviderResult<Definition | DefinitionLink[]> {
		const artifact = this.artifactLookup(document.uri);
		const source = artifact?.lines[position.line]?.source;
		if (
			!artifact
			|| !artifactDefinitions[artifact.kind].navigation.definitions
			|| !source?.file
			|| source.line === null
		) {
			return undefined;
		}
		return new Location(
			Uri.file(path.normalize(source.file)),
			new Position(source.line - 1, source.column ?? 0),
		);
	}

	provideDocumentLinks(
		document: TextDocument,
		_token: CancellationToken,
	): ProviderResult<DocumentLink[]> {
		const artifact = this.artifactLookup(document.uri);
		if (!artifact || !artifactDefinitions[artifact.kind].navigation.links) {
			return undefined;
		}
		return artifact.links.map(link => new DocumentLink(
			new Range(
				link.line,
				link.startCharacter,
				link.line,
				link.endCharacter,
			),
			document.uri.with({ fragment: `L${link.targetLine + 1}` }),
		));
	}

	provideFoldingRanges(
		document: TextDocument,
		_context: unknown,
		_token: CancellationToken,
	): ProviderResult<FoldingRange[]> {
		const artifact = this.artifactLookup(document.uri);
		if (!artifact || !artifactDefinitions[artifact.kind].navigation.folds) {
			return undefined;
		}
		return artifact.folds.map(fold => new FoldingRange(fold.startLine, fold.endLine));
	}

	provideHover(
		document: TextDocument,
		position: Position,
		_token: CancellationToken,
	): ProviderResult<Hover> {
		const artifact = this.artifactLookup(document.uri);
		const line = artifact?.lines[position.line];
		if (!artifact || !line) {
			return undefined;
		}
		const contents = new MarkdownString();
		contents.isTrusted = false;
		const documentation = documentationForInstruction(
			artifact,
			line.disassembly ?? line.text,
		);
		if (documentation) {
			contents.appendMarkdown(`**${documentation.mnemonic}** _(${documentation.instructionSet})_ — `);
			contents.appendText(documentation.tooltip);
			if (documentation.url) {
				contents.appendMarkdown(`\n\n[Instruction reference](${documentation.url})`);
			}
		}
		if (line.address !== undefined || line.opcodes?.length) {
			if (contents.value) {
				contents.appendMarkdown('\n\n');
			}
			const details = [
				line.address === undefined ? undefined : `Address: 0x${line.address.toString(16)}`,
				line.opcodes?.length ? `Bytes: ${line.opcodes.join(' ')}` : undefined,
			].filter((value): value is string => Boolean(value));
			contents.appendText(details.join(' · '));
		}
		const link = artifact.links.find(candidate =>
			candidate.line === position.line
			&& position.character >= candidate.startCharacter
			&& position.character <= candidate.endCharacter)
			?? artifact.links.find(candidate => candidate.line === position.line);
		if (link) {
			const target = artifact.lines[link.targetLine]?.text.trim();
			if (contents.value) {
				contents.appendMarkdown('\n\n');
			}
			contents.appendText(`Branch target: ${target || `line ${link.targetLine + 1}`}`);
		}
		const source = line.source;
		if (
			artifactDefinitions[artifact.kind].navigation.sourceLocations
			&& source?.file
			&& source.line !== null
		) {
			if (contents.value) {
				contents.appendMarkdown('\n\n');
			}
			const location = `${source.file}:${source.line}${source.column === undefined ? '' : `:${source.column + 1}`}`;
			contents.appendText(`Source: ${location}`);
		}
		if (!contents.value) {
			return undefined;
		}
		return new Hover(contents);
	}

	provideDocumentSymbols(
		document: TextDocument,
		_token: CancellationToken,
	): ProviderResult<DocumentSymbol[]> {
		const artifact = this.artifactLookup(document.uri);
		if (!artifact || !artifactDefinitions[artifact.kind].navigation.symbols) {
			return undefined;
		}
		return artifact.symbols.flatMap(symbol => {
			const line = artifact.lines[symbol.line];
			if (!line) {
				return [];
			}
			const range = new Range(symbol.line, 0, symbol.line, line.text.length);
			return [new DocumentSymbol(symbol.name, '', SymbolKind.Function, range, range)];
		});
	}
}
