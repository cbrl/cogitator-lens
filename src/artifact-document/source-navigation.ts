import {
	CodeLens,
	Disposable,
	EventEmitter,
	Hover,
	MarkdownString,
	Position,
	Range,
	Selection,
	TextEditorRevealType,
	Uri,
	ViewColumn,
	commands,
	window,
	type CancellationToken,
	type CodeLensProvider,
	type Event,
	type HoverProvider,
	type TextDocument,
} from 'vscode';
import { artifactDefinitions } from '../artifacts/core/artifact-definitions.js';
import {
	functionSummaries,
	isExceptionFunclet,
	linesFromSource,
	previewText,
} from '../artifacts/core/source-summary.js';
import type { ConfigurationService } from '../services/configuration-service.js';
import type { ArtifactKind, RenderedTextArtifact } from '../types/index.js';
import { equalUri } from '../file-identity.js';
import type { ArtifactDocumentRegistry, ArtifactRegistryDocument } from './artifact-document-registry.js';

/** The artifact kinds whose lines are code generated from the source, so a source line can show them. */
const generatedCodeKinds: ReadonlySet<ArtifactKind> = new Set([
	'assembly',
	'binary-disassembly',
	'llvm-ir',
	'rust-mir',
]);
/** The number of artifact lines that one hover shows for each artifact. */
const hoverLineLimit = 12;
/** How long Reveal in Artifact waits for a compile to end. */
const revealWaitMs = 120_000;

/** The arguments of `coglens.RevealInArtifact` from a CodeLens. */
interface RevealArguments {
	readonly artifactUri: string;
	readonly line: number;
}

/** An open text artifact of a source and its current listing. */
interface OpenListing {
	readonly document: ArtifactRegistryDocument;
	readonly artifact: RenderedTextArtifact;
}

/**
 * Connects a source to its open artifacts: a hover that shows the generated lines, an optional
 * CodeLens with the instruction count of each function, and a command that reveals the lines.
 * Only open artifacts supply the lines. Nothing here starts a compile.
 */
export class SourceNavigation implements HoverProvider, CodeLensProvider, Disposable {
	private readonly codeLensEmitter = new EventEmitter<void>();
	private readonly subscriptions: Disposable;

	readonly onDidChangeCodeLenses: Event<void> = this.codeLensEmitter.event;

	constructor(
		private readonly registry: ArtifactDocumentRegistry,
		private readonly configuration: ConfigurationService,
	) {
		const changed = (): void => this.codeLensEmitter.fire();
		this.subscriptions = Disposable.from(
			registry.onDidChangeArtifactState(changed),
			registry.onDidChangeDocuments(changed),
			configuration.onDidChange((change) => {
				if (change.affects('functionCodeLens')) {
					changed();
				}
			}),
			commands.registerCommand('coglens.RevealInArtifact', (argument?: RevealArguments) =>
				this.revealInArtifact(argument),
			),
			this.codeLensEmitter,
		);
	}

	provideHover(document: TextDocument, position: Position, _token: CancellationToken): Hover | undefined {
		// The compiler reads the saved file, so the lines of an edited source do not match.
		if (document.uri.scheme !== 'file' || document.isDirty) {
			return undefined;
		}
		const contents = new MarkdownString();
		for (const { document: artifactDocument, artifact } of this.listingsOf(document.uri)) {
			const lines = linesFromSource(artifact, document.uri.fsPath, position.line);
			if (lines.length === 0) {
				continue;
			}
			const { artifactLabel, toolchainLabel } = artifactDocument.identity;
			if (contents.value) {
				contents.appendMarkdown('\n\n');
			}
			contents.appendMarkdown(`**${escapeMarkdown(artifactLabel)}** · ${escapeMarkdown(toolchainLabel)}\n\n`);
			contents.appendCodeblock(previewText(artifact, lines, hoverLineLimit), codeBlockLanguage(artifact));
		}
		return contents.value ? new Hover(contents) : undefined;
	}

	provideCodeLenses(document: TextDocument, _token: CancellationToken): CodeLens[] {
		if (
			document.uri.scheme !== 'file' ||
			document.isDirty ||
			!this.configuration.getFunctionCodeLens(document.uri)
		) {
			return [];
		}
		const lenses: CodeLens[] = [];
		for (const { document: artifactDocument, artifact } of this.listingsOf(document.uri)) {
			// Template instances and clones can start at the same source line, so they share one lens.
			const bySourceLine = new Map<number, { functions: number; instructions: number; artifactLine: number }>();
			for (const summary of functionSummaries(artifact, document.uri.fsPath)) {
				if (summary.sourceLine >= document.lineCount) {
					continue;
				}
				const entry = bySourceLine.get(summary.sourceLine);
				bySourceLine.set(summary.sourceLine, {
					functions: (entry?.functions ?? 0) + (isExceptionFunclet(summary.name) ? 0 : 1),
					instructions: (entry?.instructions ?? 0) + summary.instructionCount,
					artifactLine: entry?.artifactLine ?? summary.artifactLine,
				});
			}
			for (const [sourceLine, entry] of bySourceLine) {
				const functions = entry.functions > 1 ? `${entry.functions} functions, ` : '';
				const instructions = `${entry.instructions} instruction${entry.instructions === 1 ? '' : 's'}`;
				lenses.push(
					new CodeLens(document.lineAt(sourceLine).range, {
						title: `${artifactDocument.identity.artifactLabel}: ${functions}${instructions}`,
						tooltip: `Reveal in ${artifactDocument.identity.artifactLabel} (${artifactDocument.identity.toolchainLabel})`,
						command: 'coglens.RevealInArtifact',
						arguments: [
							{
								artifactUri: artifactDocument.uri.toString(),
								line: entry.artifactLine,
							} satisfies RevealArguments,
						],
					}),
				);
			}
		}
		return lenses;
	}

	dispose(): void {
		this.subscriptions.dispose();
	}

	/** The open text artifacts of a source that hold generated code, with their current listing. */
	private listingsOf(source: Uri): OpenListing[] {
		return this.registry.documentsOf(source).flatMap((document) => {
			const artifact = document.handler.status.artifact;
			return artifact?.presentation === 'text' && generatedCodeKinds.has(document.parsed.artifactKind)
				? [{ document, artifact }]
				: [];
		});
	}

	/**
	 * Reveals the artifact lines of the source line at the cursor. Without an open artifact of the
	 * source, it opens one first and waits for its compile.
	 */
	private async revealInArtifact(argument?: RevealArguments): Promise<void> {
		if (argument) {
			const uri = Uri.parse(argument.artifactUri);
			await this.revealLines(uri, [argument.line]);
			return;
		}
		const editor = window.activeTextEditor;
		if (!editor || editor.document.uri.scheme !== 'file') {
			await window.showInformationMessage('Open a source file to reveal its lines in an artifact.');
			return;
		}
		if (editor.document.isDirty) {
			await window.showInformationMessage(
				'Save the source first. The artifact shows the saved file, so its lines do not match the edits.',
			);
			return;
		}
		const source = editor.document.uri;
		const line = editor.selection.active.line;
		let listing = this.preferredListing(source);
		if (!listing) {
			const open = this.registry
				.documentsOf(source)
				.find((document) => generatedCodeKinds.has(document.parsed.artifactKind));
			if (!open) {
				await commands.executeCommand('coglens.OpenArtifact', { kind: 'assembly' });
			}
			const document =
				open ??
				this.registry
					.documentsOf(source)
					.find((candidate) => generatedCodeKinds.has(candidate.parsed.artifactKind));
			if (!document) {
				return;
			}
			await this.compileEnd(document.uri);
			listing = this.preferredListing(source);
			if (!listing) {
				await window.showInformationMessage(
					`The ${document.identity.artifactLabel} artifact has no listing. Hover its first line for the failure.`,
				);
				return;
			}
		}
		const lines = linesFromSource(listing.artifact, source.fsPath, line);
		if (lines.length === 0) {
			await this.revealLines(listing.document.uri, []);
			await window.showInformationMessage(
				`No ${listing.document.identity.artifactLabel} line comes from line ${line + 1} of the source.`,
			);
			return;
		}
		await this.revealLines(listing.document.uri, lines);
	}

	/** An open listing of the source. A visible one comes first. */
	private preferredListing(source: Uri): OpenListing | undefined {
		const listings = this.listingsOf(source);
		return (
			listings.find((listing) =>
				window.visibleTextEditors.some((editor) => equalUri(editor.document.uri, listing.document.uri)),
			) ?? listings[0]
		);
	}

	/** Shows an artifact beside the source, keeps the focus in the source, and selects the lines. */
	private async revealLines(uri: Uri, lines: readonly number[]): Promise<void> {
		const visible = window.visibleTextEditors.find((editor) => equalUri(editor.document.uri, uri));
		const editor = await window.showTextDocument(uri, {
			viewColumn: visible?.viewColumn ?? ViewColumn.Beside,
			preserveFocus: true,
			preview: false,
		});
		if (lines.length === 0) {
			return;
		}
		const ranges = contiguousRanges(lines).map(
			([first, last]) =>
				new Selection(
					first,
					0,
					last,
					editor.document.lineAt(Math.min(last, editor.document.lineCount - 1)).text.length,
				),
		);
		editor.selections = ranges;
		editor.revealRange(new Range(ranges[0].start, ranges[0].end), TextEditorRevealType.InCenterIfOutsideViewport);
	}

	/** Waits until the compile of a document ends, or until the time limit. */
	private compileEnd(uri: Uri): Promise<void> {
		return new Promise((resolve) => {
			const ended = (): boolean => {
				const state = this.registry.document(uri)?.handler.status.state;
				return state === undefined || state === 'successful' || state === 'failed' || state === 'cancelled';
			};
			const finish = (): void => {
				subscription.dispose();
				clearTimeout(timer);
				resolve();
			};
			const subscription = this.registry.onDidChangeArtifactState(() => {
				if (ended()) {
					finish();
				}
			});
			const timer = setTimeout(finish, revealWaitMs);
			if (this.registry.document(uri)?.handler.status.artifact && ended()) {
				finish();
			}
		});
	}
}

/** Groups sorted line numbers into runs of consecutive lines. */
function contiguousRanges(lines: readonly number[]): Array<[number, number]> {
	const ranges: Array<[number, number]> = [];
	for (const line of [...lines].sort((left, right) => left - right)) {
		const last = ranges.at(-1);
		if (last && line === last[1] + 1) {
			last[1] = line;
		} else {
			ranges.push([line, line]);
		}
	}
	return ranges;
}

function codeBlockLanguage(artifact: RenderedTextArtifact): string {
	switch (artifact.listingSyntax ?? artifactDefinitions[artifact.kind].listingSyntax) {
		case 'native-assembly':
			return 'asm';
		case 'llvm-ir':
			return 'llvm';
		default:
			return '';
	}
}

function escapeMarkdown(text: string): string {
	return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}
