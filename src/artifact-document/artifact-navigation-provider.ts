import path from 'path';
import {
	CallHierarchyIncomingCall,
	CallHierarchyItem,
	CallHierarchyOutgoingCall,
	DocumentHighlight,
	DocumentHighlightKind,
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
	type CallHierarchyProvider,
	type CancellationToken,
	type DocumentHighlightProvider,
	type ReferenceProvider,
} from 'vscode';
import type { RenderedTextArtifact } from '../types/index.js';
import { documentationForInstruction, instructionSetLabels, instructionSetOf } from './instruction-documentation.js';
import { functionAt, functionCalls, linkAt, linksTo } from '../artifacts/core/artifact-calls.js';
import { functionRanges, type FunctionRange } from '../artifacts/core/artifact-views.js';
import { registerFamily, type RegisterArchitecture } from '../artifacts/core/register-families.js';

/** A word of a listing: a register, a label, a symbol, or an LLVM IR value. */
const listingWord = /st\(\d\)|[%@$.]?[A-Za-z_.$][\w.$@]*|[%!]\d+/;
/** The number of highlights that one word shows. A larger number slows a long listing. */
const highlightLimit = 2000;

type ArtifactLookup = (uri: Uri) => RenderedTextArtifact | undefined;

/**
 * A link on the name of each pass of a pipeline, which compares the function before and after the
 * pass. The link gives the number of the pass only: the command reads the document of the focused
 * editor, because VS Code decodes the arguments of a command link twice.
 */
function passLinks(artifact: RenderedTextArtifact): DocumentLink[] {
	return (artifact.passes ?? []).flatMap((pass) => {
		const text = artifact.lines[pass.line]?.text ?? '';
		const start = text.indexOf(pass.name);
		if (start < 0) {
			return [];
		}
		const argumentsText = encodeURIComponent(JSON.stringify([pass.number]));
		const link = new DocumentLink(
			new Range(pass.line, start, pass.line, start + pass.name.length),
			Uri.parse(`command:coglens.ShowPassChange?${argumentsText}`),
		);
		link.tooltip = 'Compare the function before and after this pass';
		return [link];
	});
}

export class ArtifactNavigationProvider
	implements
		DefinitionProvider,
		DocumentLinkProvider,
		FoldingRangeProvider,
		HoverProvider,
		DocumentSymbolProvider,
		DocumentHighlightProvider,
		ReferenceProvider,
		CallHierarchyProvider
{
	constructor(private readonly artifactLookup: ArtifactLookup) {}

	provideDefinition(
		document: TextDocument,
		position: Position,
		_token: CancellationToken,
	): ProviderResult<Definition | DefinitionLink[]> {
		const artifact = this.artifactLookup(document.uri);
		const source = artifact?.lines[position.line]?.source;
		if (!source?.file || source.line === null) {
			return undefined;
		}
		return new Location(Uri.file(path.normalize(source.file)), new Position(source.line - 1, source.column ?? 0));
	}

	provideDocumentLinks(document: TextDocument, _token: CancellationToken): ProviderResult<DocumentLink[]> {
		const artifact = this.artifactLookup(document.uri);
		if (!artifact) {
			return undefined;
		}
		const jumps = artifact.links.map(
			(link) =>
				new DocumentLink(
					new Range(link.line, link.startCharacter, link.line, link.endCharacter),
					document.uri.with({ fragment: `L${link.targetLine + 1}` }),
				),
		);
		return [...jumps, ...passLinks(artifact)];
	}

	provideFoldingRanges(
		document: TextDocument,
		_context: unknown,
		_token: CancellationToken,
	): ProviderResult<FoldingRange[]> {
		return this.artifactLookup(document.uri)?.folds.map((fold) => new FoldingRange(fold.startLine, fold.endLine));
	}

	provideHover(document: TextDocument, position: Position, _token: CancellationToken): ProviderResult<Hover> {
		const artifact = this.artifactLookup(document.uri);
		const line = artifact?.lines[position.line];
		if (!artifact || !line) {
			return undefined;
		}
		const contents = new MarkdownString();
		contents.isTrusted = false;
		const documentation = documentationForInstruction(artifact, line.disassembly ?? line.text);
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
		const link =
			artifact.links.find(
				(candidate) =>
					candidate.line === position.line &&
					position.character >= candidate.startCharacter &&
					position.character <= candidate.endCharacter,
			) ?? artifact.links.find((candidate) => candidate.line === position.line);
		if (link) {
			const target = artifact.lines[link.targetLine]?.text.trim();
			if (contents.value) {
				contents.appendMarkdown('\n\n');
			}
			contents.appendText(`Branch target: ${target || `line ${link.targetLine + 1}`}`);
		}
		const source = line.source;
		if (source?.file && source.line !== null) {
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

	provideDocumentSymbols(document: TextDocument, _token: CancellationToken): ProviderResult<DocumentSymbol[]> {
		const artifact = this.artifactLookup(document.uri);
		if (!artifact) {
			return undefined;
		}
		return artifact.symbols.flatMap((symbol) => {
			const line = artifact.lines[symbol.line];
			if (!line) {
				return [];
			}
			const range = new Range(symbol.line, 0, symbol.line, line.text.length);
			return [new DocumentSymbol(symbol.name, '', SymbolKind.Function, range, range)];
		});
	}

	/**
	 * Highlights each use of a register family, such as `rax`, `eax`, and `al`, in the function
	 * at the position. Another word is highlighted where it occurs in the listing.
	 */
	provideDocumentHighlights(
		document: TextDocument,
		position: Position,
		_token: CancellationToken,
	): ProviderResult<DocumentHighlight[]> {
		const artifact = this.artifactLookup(document.uri);
		const wordRange = document.getWordRangeAtPosition(position, listingWord);
		if (!artifact || !wordRange) {
			return undefined;
		}
		const word = document.getText(wordRange);
		const architecture = registerArchitecture(artifact);
		const family = architecture && registerFamily(word, architecture);
		const scope = family ? functionAt(functionRanges(artifact), position.line) : undefined;
		const firstLine = scope?.startLine ?? 0;
		const lastLine = Math.min(scope?.endLine ?? document.lineCount - 1, document.lineCount - 1);
		const pattern = new RegExp(listingWord.source, 'g');
		const highlights: DocumentHighlight[] = [];
		for (let line = firstLine; line <= lastLine && highlights.length < highlightLimit; line++) {
			for (const match of document.lineAt(line).text.matchAll(pattern)) {
				if (architecture && family ? registerFamily(match[0], architecture) === family : match[0] === word) {
					highlights.push(
						new DocumentHighlight(
							new Range(line, match.index, line, match.index + match[0].length),
							DocumentHighlightKind.Text,
						),
					);
				}
			}
		}
		return highlights;
	}

	/** The links to the label or the value at the position, and the line that defines it. */
	provideReferences(
		document: TextDocument,
		position: Position,
		context: { readonly includeDeclaration: boolean },
		_token: CancellationToken,
	): ProviderResult<Location[]> {
		const artifact = this.artifactLookup(document.uri);
		if (!artifact) {
			return undefined;
		}
		const targetLine =
			linkAt(artifact, position.line, position.character)?.targetLine ??
			(linksTo(artifact, position.line).length > 0 ? position.line : undefined);
		if (targetLine === undefined) {
			return undefined;
		}
		const references = linksTo(artifact, targetLine).map(
			(link) =>
				new Location(document.uri, new Range(link.line, link.startCharacter, link.line, link.endCharacter)),
		);
		const definition = artifact.lines[targetLine];
		return context.includeDeclaration && definition
			? [new Location(document.uri, new Range(targetLine, 0, targetLine, definition.text.length)), ...references]
			: references;
	}

	prepareCallHierarchy(
		document: TextDocument,
		position: Position,
		_token: CancellationToken,
	): ProviderResult<CallHierarchyItem> {
		const artifact = this.artifactLookup(document.uri);
		if (!artifact) {
			return undefined;
		}
		const ranges = functionRanges(artifact);
		// On a call, the item is the called function. Elsewhere, it is the function that holds the position.
		const link = linkAt(artifact, position.line, position.character);
		const called = link && ranges.find((range) => range.startLine === link.targetLine);
		const range = called ?? functionAt(ranges, position.line);
		return range && callHierarchyItem(document.uri, artifact, range);
	}

	provideCallHierarchyIncomingCalls(
		item: CallHierarchyItem,
		_token: CancellationToken,
	): ProviderResult<CallHierarchyIncomingCall[]> {
		const artifact = this.artifactLookup(item.uri);
		if (!artifact) {
			return undefined;
		}
		return functionCalls(artifact)
			.filter((call) => call.callee.startLine === item.range.start.line)
			.map(
				(call) =>
					new CallHierarchyIncomingCall(
						callHierarchyItem(item.uri, artifact, call.caller),
						call.links.map(
							(link) => new Range(link.line, link.startCharacter, link.line, link.endCharacter),
						),
					),
			);
	}

	provideCallHierarchyOutgoingCalls(
		item: CallHierarchyItem,
		_token: CancellationToken,
	): ProviderResult<CallHierarchyOutgoingCall[]> {
		const artifact = this.artifactLookup(item.uri);
		if (!artifact) {
			return undefined;
		}
		return functionCalls(artifact)
			.filter((call) => call.caller.startLine === item.range.start.line)
			.map(
				(call) =>
					new CallHierarchyOutgoingCall(
						callHierarchyItem(item.uri, artifact, call.callee),
						call.links.map(
							(link) => new Range(link.line, link.startCharacter, link.line, link.endCharacter),
						),
					),
			);
	}
}

/** The register set of a listing. A listing without machine registers, such as LLVM IR, has none. */
function registerArchitecture(artifact: RenderedTextArtifact): RegisterArchitecture | undefined {
	switch (instructionSetOf(artifact)) {
		case instructionSetLabels.amd64:
			return 'x86';
		case instructionSetLabels.aarch64:
			return 'aarch64';
		default:
			return undefined;
	}
}

function callHierarchyItem(uri: Uri, artifact: RenderedTextArtifact, range: FunctionRange): CallHierarchyItem {
	const endText = artifact.lines[range.endLine]?.text ?? '';
	const nameLine = artifact.lines[range.startLine]?.text ?? '';
	return new CallHierarchyItem(
		SymbolKind.Function,
		range.name,
		'',
		uri,
		new Range(range.startLine, 0, range.endLine, endText.length),
		new Range(range.startLine, 0, range.startLine, nameLine.length),
	);
}
