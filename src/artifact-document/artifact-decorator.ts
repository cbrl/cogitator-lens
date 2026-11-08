import {
	DecorationOptions,
	Disposable,
	Event,
	MarkdownString,
	Range,
	TextDocument,
	TextDocumentChangeEvent,
	TextEditor,
	TextEditorDecorationType,
	TextEditorRevealType,
	TextEditorSelectionChangeEvent,
	TextEditorVisibleRangesChangeEvent,
	Uri,
	window,
	workspace,
} from 'vscode';
import { buildSourceLineMap, lineHasSource, type SourceLineMap } from './source-line-map.js';
import path from 'path';
import { equalUri, sourceUriComparisonKey } from '../file-identity.js';
import {
	allDecorations,
	binaryColumnsDecoration,
	jumpArrowDecorations,
	annotationStyleDecorations,
	mappingDecorations,
	selectedLineDecoration,
	selectedSourceRangeDecoration,
	stateDecoration,
	sourceDensityDecorations,
	sourceLineBandDecorations,
	unusedLineDecoration,
} from './decorations/decoration-styles.js';
import type { ConfigurationService } from '../services/configuration-service.js';
import { failureDetails } from '../compilation/compilation-service.js';
import {
	showsSavedFileOnly,
	type ArtifactSourceText,
	type ArtifactStatus,
	type ArtifactState,
} from './artifact-generator.js';
import type { ArtifactKind, ArtifactOptions, RenderedArtifactLine, RenderedTextArtifact } from '../types/index.js';
import { artifactSupportsOption } from '../artifacts/core/artifact-definitions.js';
import {
	artifactScrollAnchor,
	ScrollSyncSuppression,
	sourceDensityLevel,
	sourceLineBandIndex,
	sourceScrollAnchor,
} from './source-bridge.js';
import { jumpArrows, type JumpArrowDirection } from './jump-arrows.js';
import { annotationShows } from '../artifacts/core/source-annotations.js';
import { LineShift, type LineChange } from './line-shift.js';

/*
Nice-to-have features:
 - Hover line in artifact/source editor highlights corresponding source/artifact line(s) (only on currently visible files, don't open new ones)
   - The API does not give the line under the mouse. A source hover (source-navigation.ts) shows the
     artifact lines of the hovered source line instead.
 - Ctrl-click opens corresponding editor (if not open) then highlights lines
   - VSCode has a 10+ year old issue (#3130) for adding mouse shortcut customization
   - Definition provider seems like the best way to do this for now
     - The UX for this isn't ideal unless the user changes VS Code settings to open definitions in an existing editor (can some ugly hacks work around this?)
*/

/**
 * A text artifact and the source map derived from it. The lines of the main source are moved to its
 * current text, so they stay on the right lines while the user types.
 */
interface MappedArtifact {
	readonly artifact: RenderedTextArtifact;
	readonly sources: SourceLineMap;
}

/** The artifact that the document shows, as the compile made it, and the source text that it comes from. */
interface ShownArtifact {
	readonly artifact: RenderedTextArtifact;
	readonly sourceText?: ArtifactSourceText;
}

/** The changes of one event of the main source, and the document version after them. */
interface SourceChange {
	readonly version: number;
	readonly changes: readonly LineChange[];
}

/** The number of change events of the main source that a decorator keeps. */
const maximumSourceChanges = 5_000;

type DecorationList = readonly Range[] | readonly DecorationOptions[];

/** Receives the decorations of an editor. */
interface DecorationSink {
	set(editor: TextEditor, type: TextEditorDecorationType, decorations: DecorationList): void;
}

const directSink: DecorationSink = {
	set: (editor, type, decorations) => editor.setDecorations(type, decorations),
};

/**
 * Collects the decorations of a redraw. Each editor then gets each type once, and no type is cleared
 * first, so the decorations do not flash.
 */
class DecorationBatch implements DecorationSink {
	private readonly byEditor = new Map<TextEditor, Map<TextEditorDecorationType, DecorationList>>();

	set(editor: TextEditor, type: TextEditorDecorationType, decorations: DecorationList): void {
		const decorationsOfEditor = this.byEditor.get(editor) ?? new Map<TextEditorDecorationType, DecorationList>();
		decorationsOfEditor.set(type, decorations);
		this.byEditor.set(editor, decorationsOfEditor);
	}

	/** Sets each type on each editor. A type that the redraw did not set gets no decorations. */
	apply(editors: Iterable<TextEditor>): void {
		for (const editor of new Set([...editors, ...this.byEditor.keys()])) {
			const decorationsOfEditor = this.byEditor.get(editor);
			for (const type of allDecorations) {
				editor.setDecorations(type, decorationsOfEditor?.get(type) ?? []);
			}
		}
	}
}

/**
 * Manages decorations for artifact documents, including dimming unused source lines and highlighting corresponding
 * lines between source and artifact. Each instance of ArtifactDecorator is associated with one artifact document and its
 * referenced source documents.
 *
 * Decorations are only active when the artifact document is visible along with at least one of its referenced source
 * documents.
 *
 * The decorator follows the edits of the main source. It keeps the changes after the version of the
 * shown artifact, and it moves the mapped lines through them. Then the highlights stay on the right
 * lines while the user types, and a listing of earlier text maps to the current text.
 */
export class ArtifactDecorator {
	private readonly sourceUri: Uri;
	private readonly artifactUri: Uri;

	private shown?: ShownArtifact;
	/** The shown artifact with its main-source lines moved to the current text. It is made again when needed. */
	private mapped?: MappedArtifact;
	private compilationState: ArtifactState = 'stale';
	private truncated = false;
	private failure?: Error;
	/** Whether the last compile failed while it read unsaved text. */
	private failedUnsavedText = false;

	private readonly configService: ConfigurationService;
	private readonly registrations: Disposable;

	private active: boolean = true;
	private readonly synchronizedScroll = new ScrollSyncSuppression<TextEditor>();
	/**
	 * Mapped sources other than the main source with unsaved edits, by URI. No compile reads them,
	 * so the line mapping of an edited header is wrong until the next save, and it stops until then.
	 */
	private readonly dirtySources = new Set<string>();
	/** The changes of the main source after the version that the shift starts at. */
	private readonly sourceChanges: SourceChange[] = [];
	/** Moves the main-source lines of the shown artifact to the current text, when the decorator knows how. */
	private shift?: LineShift;
	/** Whether the main source closed after the artifact was shown. Then the version of the artifact means nothing. */
	private sourceClosedSinceShown = false;
	/** Whether the main source had unsaved edits at the last event. */
	private mainSourceDirty = false;
	private readonly sourceKeys = new Map<string, string>();
	private readonly mainSourceKey: string;

	constructor(
		sourceUri: Uri,
		artifactUri: Uri,
		statusEvent: Event<ArtifactStatus>,
		configService: ConfigurationService,
		private readonly artifactOptions: (kind: ArtifactKind) => ArtifactOptions,
		decorationOptionsEvent: Event<ArtifactKind>,
		/** Whether the document shows a notice, such as the placeholder, in place of the artifact. */
		private readonly showsNotice: () => boolean = () => false,
	) {
		this.artifactUri = artifactUri;
		this.sourceUri = sourceUri;
		this.configService = configService;
		this.mainSourceKey = this.sourceKey(sourceUri);
		this.mainSourceDirty = Boolean(this.mainSourceDocument()?.isDirty);

		this.syncDirtySources();
		this.refreshDecorations();

		// Rebuild the source map when the artifact changes. A status keeps the last artifact while it
		// compiles, goes stale, or fails, so the decorations stay on the text the editor still shows.
		const providerEventRegistration = statusEvent((status) => {
			this.compilationState = status.state;
			this.truncated = status.truncated;
			this.failure = status.state === 'failed' ? status.error : undefined;
			this.failedUnsavedText = status.state === 'failed' && status.readUnsavedText;
			const artifact = status.artifact?.presentation === 'text' ? status.artifact : undefined;
			if (artifact === this.shown?.artifact) {
				// Only the state changed, so only its text changes.
				this.setStateDecoration(directSink);
				return;
			}
			this.shown = artifact && { artifact, sourceText: status.sourceText };
			this.sourceClosedSinceShown = false;
			this.resetShift();
			this.syncDirtySources();
			this.refreshDecorations();
		});

		const visibilityChangeRegistration = window.onDidChangeVisibleTextEditors(
			this.onChangeVisibleEditors.bind(this),
		);

		const selectionChangeRegistration = window.onDidChangeTextEditorSelection(
			this.onEditorSelectionChanged.bind(this),
		);
		const visibleRangesRegistration = window.onDidChangeTextEditorVisibleRanges(
			this.onEditorVisibleRangesChanged.bind(this),
		);

		const documentChangeRegistration = Disposable.from(
			workspace.onDidChangeTextDocument((event) => {
				if (equalUri(event.document.uri, this.artifactUri)) {
					this.refreshDecorations();
				} else if (this.isMainSource(event.document.uri)) {
					this.onMainSourceChanged(event);
				} else {
					this.updateDirtySources(event.document);
				}
			}),
			// A save does not always change the text, so it can come without a change event.
			workspace.onDidSaveTextDocument((document) => {
				if (this.isMainSource(document.uri)) {
					this.updateMainSourceState(document);
				} else {
					this.updateDirtySources(document);
				}
			}),
			workspace.onDidOpenTextDocument((document) => {
				if (this.isMainSource(document.uri)) {
					this.resetShift();
				}
			}),
			workspace.onDidCloseTextDocument((document) => {
				if (this.isMainSource(document.uri)) {
					this.onMainSourceClosed();
				} else {
					this.updateDirtySources(document);
				}
			}),
		);

		// Options that change only decorations do not render the artifact again, so redraw here.
		const decorationOptionsRegistration = Disposable.from(
			decorationOptionsEvent((kind) => {
				if (this.shown?.artifact.kind === kind) {
					this.refreshDecorations();
				}
			}),
			configService.onDidChange((change) => {
				if (change.affects('dimUnusedSourceLines') || change.affects('optimizationRemarkCategories')) {
					this.refreshDecorations();
				} else if (change.affects('compileOnType')) {
					this.setStateDecoration(directSink);
				}
			}),
		);

		this.registrations = Disposable.from(
			providerEventRegistration,
			decorationOptionsRegistration,
			visibilityChangeRegistration,
			selectionChangeRegistration,
			visibleRangesRegistration,
			documentChangeRegistration,
		);
	}

	public dispose(): void {
		this.synchronizedScroll.dispose();
		this.clearAllDecorations();
		this.registrations.dispose();
	}

	public onEditorSelectionChanged(event: TextEditorSelectionChangeEvent): void {
		// This event will fire when an editor is opened as well, in which case the kind will be undefined. We don't
		// want to process that event, since it would act as if the user clicked whichever line happens to be selected
		// in that new editor when it opens. This would cause problems when the selected artifact line causes a new source
		// editor to open, since it would override the line that the user selected with the line that was selected when
		// the new editor opened.
		if (event.kind === undefined || !this.active) {
			return;
		}

		this.withContent((content) => {
			if (this.isMappedEditor(content, event.textEditor)) {
				this.onSrcLineSelected(content, event.textEditor);
			} else if (equalUri(event.textEditor.document.uri, this.artifactUri)) {
				this.onArtifactLineSelected(content, event.textEditor);
			}
		});
	}

	public onEditorVisibleRangesChanged(event: TextEditorVisibleRangesChangeEvent): void {
		if (this.synchronizedScroll.shouldSuppress(event.textEditor)) {
			return;
		}
		if (
			!this.active ||
			event.visibleRanges.length === 0 ||
			!this.configService.getSynchronizeSourceAndArtifactScrolling(this.sourceUri)
		) {
			return;
		}

		this.withContent((content) => {
			if (this.isMappedEditor(content, event.textEditor)) {
				const mapping = content.sources.get(event.textEditor.document.uri);
				const anchor = mapping
					? event.visibleRanges
							.map((range) => sourceScrollAnchor(mapping, range.start.line, range.end.line))
							.find((candidate) => candidate !== undefined)
					: undefined;
				const artifactEditor = this.artifactEditor();
				if (anchor && artifactEditor && anchor.artifactLine < artifactEditor.document.lineCount) {
					this.revealScrollAnchor(artifactEditor, anchor.artifactLine);
				}
				return;
			}

			if (!equalUri(event.textEditor.document.uri, this.artifactUri)) {
				return;
			}
			const anchor = event.visibleRanges
				.map((range) => artifactScrollAnchor(content.artifact.lines, range.start.line, range.end.line))
				.find((candidate) => candidate !== undefined);
			if (!anchor) {
				return;
			}
			const sourceUri = Uri.file(path.normalize(anchor.file));
			const targetMapping = content.sources.get(sourceUri);
			const sourceEditor =
				targetMapping === undefined
					? undefined
					: this.getAllSourceEditors(content).find(
							(editor) => content.sources.get(editor.document.uri) === targetMapping,
						);
			if (sourceEditor && anchor.sourceLine < sourceEditor.document.lineCount) {
				this.revealScrollAnchor(sourceEditor, anchor.sourceLine);
			}
		});
	}

	/** Draws each decoration again. Each editor gets each type once, so nothing flashes. */
	private refreshDecorations() {
		const batch = new DecorationBatch();
		this.withContent((content) => {
			// Recalculate active state now that content may have changed
			this.updateActiveState(content);
			this.dimUnusedSourceLines(content, batch);
			const { kind } = content.artifact;
			if (
				artifactSupportsOption(kind, 'sourceLineColorBands') &&
				this.artifactOptions(kind).display.sourceLineColorBands
			) {
				this.decorateSourceDensity(content, batch);
				this.decorateSourceLineBands(content, batch);
			}
			this.decorateListingColumns(content, batch);
			this.decorateJumpArrows(content, batch);
			this.decorateAnalysisAnnotations(content, batch);

			// Treat as if the user selected the current line of the first editor (only highlights the line, doesn't scroll)
			// TODO: use active editor instead of the first visible source editor?
			if (content.artifact.lines.length > 0) {
				const sourceEditor = this.getAllSourceEditors(content)[0];
				if (sourceEditor) {
					this.onSrcLineSelected(content, sourceEditor, true, batch);
				}
			}
		});
		this.setStateDecoration(batch);
		// An editor of a source that the mapping leaves out gets no decorations, so its old ones go.
		const artifactEditor = this.artifactEditor();
		batch.apply([...this.visibleSourceEditors(), ...(artifactEditor ? [artifactEditor] : [])]);
	}

	/** Sets the text of the state at the end of the first artifact line. */
	private setStateDecoration(sink: DecorationSink): void {
		const artifactEditor = this.artifactEditor();
		if (!artifactEditor) {
			return;
		}
		// A notice, such as the placeholder, already states what the decoration would.
		const stateText = this.showsNotice() ? undefined : this.stateDecorationText();
		sink.set(
			artifactEditor,
			stateDecoration,
			stateText
				? [
						{
							// The whole first line carries the hover, so the failure details are reachable.
							range: artifactEditor.document.lineAt(0).range,
							hoverMessage: this.failureHover(),
							renderOptions: {
								after: { contentText: ` ${stateText}` },
							},
						},
					]
				: [],
		);
	}

	private clearAllDecorations() {
		const artifactEditor = this.artifactEditor();
		const editors = this.visibleSourceEditors();
		for (const editor of artifactEditor ? [...editors, artifactEditor] : editors) {
			clearDecorations(editor, allDecorations);
		}
	}

	private dimUnusedSourceLines(content: MappedArtifact, sink: DecorationSink) {
		const getUnusedLines = (document: TextDocument) => {
			const unusedLines: Range[] = [];

			const map = content.sources.get(document.uri);
			if (map === undefined) {
				return unusedLines;
			}

			for (let line = 0; line < document.lineCount; line++) {
				if (map.get(line) === undefined) {
					unusedLines.push(document.lineAt(line).range);
				}
			}

			return unusedLines;
		};

		for (let editor of this.getAllSourceEditors(content)) {
			const dimUnused = this.configService.getDimUnusedSourceLines(editor.document.uri);

			if (dimUnused) {
				sink.set(editor, unusedLineDecoration, getUnusedLines(editor.document));
			}
		}
	}

	private decorateSourceDensity(content: MappedArtifact, sink: DecorationSink): void {
		for (const editor of this.getAllSourceEditors(content)) {
			const mapping = content.sources.get(editor.document.uri);
			if (!mapping) {
				continue;
			}
			let maximum = 0;
			for (const artifactLines of mapping.values()) {
				maximum = Math.max(maximum, artifactLines.length);
			}
			const decorations = sourceDensityDecorations.map((bandDecorations) =>
				bandDecorations.map(
					() =>
						[] as Array<{
							range: Range;
							hoverMessage: string;
						}>,
				),
			);
			for (const [sourceLine, artifactLines] of mapping) {
				if (sourceLine < 0 || sourceLine >= editor.document.lineCount || artifactLines.length === 0) {
					continue;
				}
				const band = sourceLineBandIndex(sourceLine, sourceDensityDecorations.length);
				const level = sourceDensityLevel(artifactLines.length, maximum, sourceDensityDecorations[band].length);
				decorations[band][level].push({
					range: editor.document.lineAt(sourceLine).range,
					hoverMessage: `${artifactLines.length} generated output ${artifactLines.length === 1 ? 'line' : 'lines'}`,
				});
			}
			sourceDensityDecorations.forEach((bandDecorations, band) =>
				bandDecorations.forEach((decoration, level) => sink.set(editor, decoration, decorations[band][level])),
			);
		}
	}

	private decorateListingColumns(content: MappedArtifact, sink: DecorationSink): void {
		const editor = this.artifactEditor();
		if (
			!editor ||
			!artifactSupportsOption(content.artifact.kind, 'binaryColumns') ||
			!this.artifactOptions(content.artifact.kind).display.binaryColumns
		) {
			return;
		}

		const addressWidth = Math.max(
			4,
			...content.artifact.lines.map((line) =>
				line.address === undefined ? 0 : line.address.toString(16).length,
			),
		);
		const opcodeWidth = Math.max(0, ...content.artifact.lines.map((line) => line.opcodes?.join(' ').length ?? 0));
		const options = content.artifact.lines.flatMap((line, index) => {
			if (index >= editor.document.lineCount || (line.address === undefined && !line.opcodes?.length)) {
				return [];
			}
			const address =
				line.address === undefined
					? ''.padStart(addressWidth)
					: line.address.toString(16).padStart(addressWidth, '0');
			const opcodes = (line.opcodes?.join(' ') ?? '').padEnd(opcodeWidth);
			return [
				{
					range: new Range(index, 0, index, 0),
					renderOptions: { before: { contentText: `${address}  ${opcodes}` } },
				},
			];
		});
		sink.set(editor, binaryColumnsDecoration, options);
	}

	private decorateJumpArrows(content: MappedArtifact, sink: DecorationSink): void {
		const editor = this.artifactEditor();
		if (!editor) {
			return;
		}

		const options = {
			forward: { source: [], target: [] },
			backward: { source: [], target: [] },
		} as Record<JumpArrowDirection, Record<'source' | 'target', Array<{ range: Range; hoverMessage: string }>>>;
		for (const arrow of jumpArrows(content.artifact.links, editor.document.lineCount)) {
			const source = arrow.sourceLine + 1;
			const target = arrow.targetLine + 1;
			const backward = arrow.direction === 'backward';
			options[arrow.direction].source.push({
				range: editor.document.lineAt(arrow.sourceLine).range,
				hoverMessage: backward ? `Back edge to line ${target}` : `Branch forward to line ${target}`,
			});
			options[arrow.direction].target.push({
				range: editor.document.lineAt(arrow.targetLine).range,
				hoverMessage: backward ? `Loop target from line ${source}` : `Branch target from line ${source}`,
			});
		}
		for (const direction of ['forward', 'backward'] as const) {
			sink.set(editor, jumpArrowDecorations[direction].source, options[direction].source);
			sink.set(editor, jumpArrowDecorations[direction].target, options[direction].target);
		}
	}

	private decorateSourceLineBands(content: MappedArtifact, sink: DecorationSink): void {
		const artifactEditor = this.artifactEditor();
		if (!artifactEditor) {
			return;
		}

		const artifactRanges = sourceLineBandDecorations.map(() => [] as Range[]);
		for (const editor of this.getAllSourceEditors(content)) {
			const sourceRanges = sourceLineBandDecorations.map(() => [] as Range[]);
			for (const [sourceLine, artifactLines] of content.sources.get(editor.document.uri) ?? []) {
				const band = sourceLineBandIndex(sourceLine, sourceLineBandDecorations.length);
				if (sourceLine >= 0 && sourceLine < editor.document.lineCount) {
					sourceRanges[band].push(editor.document.lineAt(sourceLine).range);
				}
				for (const artifactLine of artifactLines) {
					if (artifactLine >= 0 && artifactLine < artifactEditor.document.lineCount) {
						artifactRanges[band].push(artifactEditor.document.lineAt(artifactLine).range);
					}
				}
			}
			sourceLineBandDecorations.forEach((decoration, index) => sink.set(editor, decoration, sourceRanges[index]));
		}
		sourceLineBandDecorations.forEach((decoration, index) =>
			sink.set(artifactEditor, decoration, artifactRanges[index]),
		);
	}

	private onSrcLineSelected(
		content: MappedArtifact,
		selectedEditor: TextEditor,
		highlightOnly: boolean = false,
		sink: DecorationSink = directSink,
	): void {
		const artifactEditor = this.artifactEditor();

		if (artifactEditor === undefined) {
			return;
		}

		const getSelectedLines = (srcFile: Uri, line: number) => {
			const artifactLineRanges: Range[] = [];
			const mapped = content.sources.get(srcFile)?.get(line);

			if (mapped !== undefined) {
				for (let line of mapped) {
					if (line >= artifactEditor.document.lineCount) {
						continue;
					}
					artifactLineRanges.push(artifactEditor.document.lineAt(line).range);
				}
			}

			return artifactLineRanges;
		};

		// Highlight selected line in source editor
		const srcLineRange = selectedEditor.document.lineAt(selectedEditor.selection.start.line).range;
		sink.set(selectedEditor, selectedSourceRangeDecoration, []);
		sink.set(selectedEditor, selectedLineDecoration, [srcLineRange]);

		// Highlight associated lines in artifact editor
		const artifactLines: Range[] = getSelectedLines(
			selectedEditor.document.uri,
			selectedEditor.selection.start.line,
		);

		for (let editor of this.getAllSourceEditors(content)) {
			if (editor !== selectedEditor) {
				artifactLines.push(...getSelectedLines(editor.document.uri, editor.selection.start.line));
			}
		}

		sink.set(artifactEditor, selectedLineDecoration, artifactLines);

		if (artifactLines.length > 0 && !highlightOnly) {
			// First line will be from the editor that actually had its selection changed (the editor passed to this function)
			this.revealNavigationTarget(artifactEditor, artifactLines[0]);
		}
	}

	private onArtifactLineSelected(
		content: MappedArtifact,
		artifactEditor: TextEditor,
		highlightOnly: boolean = false,
	): void {
		const line = artifactEditor.selection.start.line;
		if (line < 0 || line >= content.artifact.lines.length || line >= artifactEditor.document.lineCount) {
			return;
		}
		const artifactLine = content.artifact.lines[line];

		// Highlight selected line in artifact editor
		const artifactLineRange = artifactEditor.document.lineAt(line).range;
		artifactEditor.setDecorations(selectedLineDecoration, [artifactLineRange]);
		artifactEditor.setDecorations(selectedSourceRangeDecoration, []);

		// Highlight associated lines only in source editors the user already has visible.
		if (lineHasSource(artifactLine)) {
			const sourceUri = Uri.file(path.normalize(artifactLine.source!.file!));
			const targetMapping = content.sources.get(sourceUri);
			const targetEditor =
				targetMapping === undefined
					? undefined
					: this.getAllSourceEditors(content).find(
							(editor) => content.sources.get(editor.document.uri) === targetMapping,
						);
			if (targetEditor) {
				const srcLineIndex = artifactLine.source!.line! - 1;
				if (srcLineIndex < 0 || srcLineIndex >= targetEditor.document.lineCount) {
					return;
				}

				const preciseRange = sourceSelectionRange(targetEditor.document, artifactLine);
				const srcLineRange = preciseRange ?? targetEditor.document.lineAt(srcLineIndex).range;
				for (const editor of this.getAllSourceEditors(content)) {
					editor.setDecorations(selectedLineDecoration, []);
					editor.setDecorations(selectedSourceRangeDecoration, []);
				}
				targetEditor.setDecorations(preciseRange ? selectedSourceRangeDecoration : selectedLineDecoration, [
					srcLineRange,
				]);

				if (!highlightOnly) {
					this.revealNavigationTarget(targetEditor, srcLineRange);
				}
			} else {
				this.clearSourceSelectionDecorations();
			}
		} else {
			// Clear selected line decoration when the artifact editor line doesn't correspond to a source location
			this.clearSourceSelectionDecorations();
		}
	}

	private clearSourceSelectionDecorations(): void {
		for (const editor of this.getAllSourceEditors()) {
			editor.setDecorations(selectedLineDecoration, []);
			editor.setDecorations(selectedSourceRangeDecoration, []);
		}
	}

	private revealScrollAnchor(editor: TextEditor, line: number): void {
		if (editor.visibleRanges[0]?.start.line === line) {
			return;
		}
		// revealRange can emit a series of visible-range events when smooth scrolling is enabled.
		// Keep the target suppressed until those events settle so they cannot synchronize back
		// into the editor that initiated the scroll. The longer initial timeout is a fallback for
		// editors that dispatch the first visible-range event asynchronously.
		this.synchronizedScroll.begin(editor);
		// The start of the line only, so a long line does not scroll the editor to its end.
		editor.revealRange(new Range(line, 0, line, 0), TextEditorRevealType.AtTop);
	}

	private revealNavigationTarget(editor: TextEditor, range: Range): void {
		// Only the lines count. The visible ranges ignore horizontal scrolling, and a reveal of a
		// whole long line scrolls the editor to the end of the line.
		if (
			editor.visibleRanges.some(
				(visibleRange) =>
					visibleRange.start.line <= range.start.line && range.end.line <= visibleRange.end.line,
			)
		) {
			return;
		}
		// A selection in one editor can scroll the other editor. Suppress the resulting
		// visible-range events so automatic scroll synchronization cannot navigate back
		// from an unrelated line that happens to be at the top of the new viewport.
		this.synchronizedScroll.begin(editor);
		editor.revealRange(new Range(range.start, range.start), TextEditorRevealType.InCenterIfOutsideViewport);
	}

	private updateActiveState(content?: MappedArtifact): void {
		const sourceUris = content?.sources;
		if (!sourceUris) {
			this.active = false;
			return;
		}
		const editors = window.visibleTextEditors;

		// Active if the artifact editor is visible and one of the associated source editors is visible
		const hasArtifactEditor = editors.some((editor) => equalUri(editor.document.uri, this.artifactUri));
		const hasAnySourceEditor = editors.some((e) => sourceUris.has(e.document.uri));

		this.active = hasArtifactEditor && hasAnySourceEditor;
	}

	private decorateAnalysisAnnotations(content: MappedArtifact, sink: DecorationSink): void {
		for (const [style, decoration] of Object.entries(annotationStyleDecorations)) {
			this.annotationDecorations(content, style, decoration, sink);
		}
	}

	private annotationDecorations(
		content: MappedArtifact,
		style: string,
		decoration: TextEditorDecorationType,
		sink: DecorationSink,
	): void {
		const editor = this.artifactEditor();
		if (!editor) {
			return;
		}
		const categories = this.configService.getOptimizationRemarkCategories();
		const options = content.artifact.lines.flatMap((line, index) => {
			if (index >= editor.document.lineCount) {
				return [];
			}
			const annotations =
				line.annotations?.filter(
					(annotation) => annotation.style === style && annotationShows(annotation, categories),
				) ?? [];
			if (annotations.length === 0) {
				return [];
			}
			const end = editor.document.lineAt(index).range.end;
			return [
				{
					range: new Range(end, end),
					renderOptions: {
						after: {
							contentText: annotations.map((annotation) => annotation.text).join(' · '),
						},
					},
				},
			];
		});
		sink.set(editor, decoration, options);
	}

	private onChangeVisibleEditors(): void {
		this.refreshDecorations();
		if (!this.active) {
			// Clear cross-editor mapping decorations if the pair is no longer visible. Listing-local columns,
			// analysis annotations, and state remain useful when the artifact is open by itself.
			for (const editor of this.getAllSourceEditors()) {
				clearDecorations(editor, allDecorations);
			}
			const artifactEditor = this.artifactEditor();
			if (artifactEditor) {
				clearDecorations(artifactEditor, mappingDecorations);
			}
		}
	}

	/** The visible editors of mapped sources. An editor of a source that the mapping leaves out is not one. */
	private getAllSourceEditors(content = this.currentContent()): TextEditor[] {
		return content ? window.visibleTextEditors.filter((editor) => this.isMappedEditor(content, editor)) : [];
	}

	/** The visible editors of mapped sources, also the ones that the mapping leaves out. */
	private visibleSourceEditors(): TextEditor[] {
		const content = this.currentContent();
		return content ? window.visibleTextEditors.filter((editor) => content.sources.has(editor.document.uri)) : [];
	}

	private isMappedEditor(content: MappedArtifact, editor: TextEditor): boolean {
		const uri = editor.document.uri;
		return (
			content.sources.has(uri) &&
			(this.isMainSource(uri) ? this.mainSourceMapped() : !this.dirtySources.has(uri.toString()))
		);
	}

	/** Whether a document is the compiled source, or a source that the artifact maps lines to. */
	private isMappedSource(document: TextDocument): boolean {
		return this.isMainSource(document.uri) || Boolean(this.currentContent()?.sources.has(document.uri));
	}

	/** Records whether a mapped source other than the main source has unsaved edits. A change redraws. */
	private updateDirtySources(document: TextDocument): void {
		const key = document.uri.toString();
		if (this.isDirtySource(document) === this.dirtySources.has(key)) {
			return;
		}
		this.syncDirtySources();
		this.refreshDecorations();
	}

	/** Finds the mapped sources other than the main source that have unsaved edits. */
	private syncDirtySources(): void {
		this.dirtySources.clear();
		for (const document of workspace.textDocuments) {
			if (this.isDirtySource(document)) {
				this.dirtySources.add(document.uri.toString());
			}
		}
	}

	private isDirtySource(document: TextDocument): boolean {
		return (
			!document.isClosed && document.isDirty && !this.isMainSource(document.uri) && this.isMappedSource(document)
		);
	}

	/**
	 * Keeps the change, and moves the mapped lines through it. The editor moves the decorations of
	 * the source by itself, so a change redraws only when the mapping starts or stops.
	 */
	private onMainSourceChanged(event: TextDocumentChangeEvent): void {
		const mappedBefore = this.mainSourceMapped();
		// An event without changes, such as a change of the line endings, still has a version.
		this.sourceChanges.push({ version: event.document.version, changes: event.contentChanges });
		if (this.sourceChanges.length > maximumSourceChanges) {
			this.sourceChanges.shift();
		}
		if (this.shift) {
			this.shift.apply(event.contentChanges);
			this.mapped = undefined;
		} else if (!event.document.isDirty) {
			// An undo to the saved text matches a listing of the saved file again.
			this.resetShift();
		}
		if (mappedBefore !== this.mainSourceMapped()) {
			this.refreshDecorations();
		} else {
			this.updateMainSourceState(event.document);
		}
	}

	/** Shows the note of unsaved edits when the main source becomes dirty or clean. */
	private updateMainSourceState(document: TextDocument): void {
		if (document.isDirty !== this.mainSourceDirty) {
			this.mainSourceDirty = document.isDirty;
			this.setStateDecoration(directSink);
		}
	}

	/** A closed document loses its versions. A new document of the file starts at version 1 again. */
	private onMainSourceClosed(): void {
		this.sourceChanges.length = 0;
		this.shift = undefined;
		this.mapped = undefined;
		this.sourceClosedSinceShown = true;
		this.mainSourceDirty = false;
		this.setStateDecoration(directSink);
	}

	/**
	 * Starts the shift of the main-source lines at the text of the shown artifact. The artifact gives
	 * the version of its text, and the kept changes must cover each version after that one. When they
	 * do not, a listing of the saved file still has the text of a clean document.
	 */
	private resetShift(): void {
		this.shift = undefined;
		this.mapped = undefined;
		const document = this.mainSourceDocument();
		const shown = this.shown;
		if (!shown || !document) {
			return;
		}
		const sourceText = shown.sourceText;
		const bases = [
			this.sourceClosedSinceShown ? undefined : sourceText?.version,
			!document.isDirty && !sourceText?.unsaved ? document.version : undefined,
		];
		for (const base of bases) {
			if (base === undefined || base > document.version) {
				continue;
			}
			const later = this.sourceChanges.filter((change) => change.version > base);
			const covered =
				later.length === document.version - base &&
				later.every((change, index) => change.version === base + index + 1);
			if (!covered) {
				continue;
			}
			this.sourceChanges.splice(0, this.sourceChanges.length - later.length);
			const shift = new LineShift(this.mainSourceLines(shown.artifact));
			for (const change of later) {
				shift.apply(change.changes);
			}
			this.shift = shift;
			return;
		}
	}

	/** Whether the lines of the main source are known in its current text. */
	private mainSourceMapped(): boolean {
		const document = this.mainSourceDocument();
		return !document || this.shift !== undefined || (!document.isDirty && !this.shown?.sourceText?.unsaved);
	}

	/** The zero-based main-source lines that the artifact names, which the shift must follow. */
	private mainSourceLines(artifact: RenderedTextArtifact): Set<number> {
		const lines = new Set<number>();
		for (const { source } of artifact.lines) {
			if (
				source?.file &&
				source.line !== null &&
				source.line !== undefined &&
				this.isMainSourceFile(source.file)
			) {
				lines.add(source.line - 1);
				if (source.endLine !== undefined) {
					lines.add(source.endLine - 1);
				}
			}
		}
		return lines;
	}

	/** The shown artifact, with its main-source lines moved to the current text. */
	private currentContent(): MappedArtifact | undefined {
		if (!this.shown) {
			return undefined;
		}
		if (!this.mapped) {
			const shift = this.shift;
			const artifact =
				shift && !shift.isIdentity
					? movedArtifact(this.shown.artifact, shift, (file) => this.isMainSourceFile(file))
					: this.shown.artifact;
			this.mapped = { artifact, sources: buildSourceLineMap(artifact) };
		}
		return this.mapped;
	}

	private mainSourceDocument(): TextDocument | undefined {
		return workspace.textDocuments.find((document) => !document.isClosed && this.isMainSource(document.uri));
	}

	private isMainSource(uri: Uri): boolean {
		return uri.scheme === 'file' && this.sourceKey(uri) === this.mainSourceKey;
	}

	private isMainSourceFile(file: string): boolean {
		return this.sourceKey(Uri.file(path.normalize(file))) === this.mainSourceKey;
	}

	/** The comparison key of a source. The keys are kept, because a key can read the file system. */
	private sourceKey(uri: Uri): string {
		const text = uri.toString();
		let key = this.sourceKeys.get(text);
		if (key === undefined) {
			key = sourceUriComparisonKey(uri);
			this.sourceKeys.set(text, key);
		}
		return key;
	}

	private artifactEditor(): TextEditor | undefined {
		return window.visibleTextEditors.find((editor) => equalUri(editor.document.uri, this.artifactUri));
	}

	private withContent<T>(action: (content: MappedArtifact) => T): T | undefined {
		const content = this.currentContent();
		return content ? action(content) : undefined;
	}

	/** Whether the user types in the main source and each pause compiles its unsaved text. */
	private typing(): boolean {
		return Boolean(this.mainSourceDocument()?.isDirty) && this.configService.getCompileOnType(this.sourceUri);
	}

	private failureHover(): MarkdownString | undefined {
		if (!this.failure || !this.shown) {
			return undefined;
		}
		const details = failureDetails(this.failure);
		const hover = new MarkdownString(
			this.failedUnsavedText
				? '**Unsaved edits do not compile.** The listing below is from the last successful compile.'
				: '**Compilation failed.** The listing below is from the last successful compile.',
		).appendCodeblock(
			details.length > maximumHoverLength ? `${details.slice(0, maximumHoverLength)}\n…` : details,
			'text',
		);
		return hover.appendMarkdown(
			this.failedUnsavedText
				? 'Save the source to see the diagnostics in the Problems view.'
				: 'Compiler diagnostics are in the Problems view.',
		);
	}

	private stateDecorationText(): string | undefined {
		const unsaved = this.unsavedNote();
		const state = this.compilationStateText();
		return state && unsaved ? `${state} ${unsaved}` : (state ?? unsaved);
	}

	/**
	 * The note for unsaved edits that the artifact does not show. No compile reads an edited header.
	 * With `coglens.compileOnType`, a compile of the unsaved text follows each pause, so the note
	 * shows only when the toolchain reads the saved file.
	 */
	private unsavedNote(): string | undefined {
		if (this.dirtySources.size > 0) {
			return unsavedSourceText;
		}
		const sourceText = this.shown?.sourceText;
		return this.mainSourceDocument()?.isDirty &&
			showsSavedFileOnly(sourceText, this.configService.getCompileOnType(this.sourceUri))
			? unsavedSourceNote(sourceText?.savedFileReason)
			: undefined;
	}

	private compilationStateText(): string | undefined {
		switch (this.compilationState) {
			case 'compiling':
				// While the user types, each pause starts a compile. The status bar shows it.
				return this.typing() ? undefined : 'Compiling…';
			case 'stale':
				return this.typing() ? undefined : 'Artifact is stale. Refresh pending.';
			case 'cancelled':
				return 'Artifact generation was cancelled.';
			case 'failed': {
				if (this.failedUnsavedText) {
					return this.shown
						? 'Unsaved edits do not compile. Showing the last successful output; hover for details.'
						: 'Unsaved edits do not compile.';
				}
				const failure = this.truncated
					? 'Compilation failed because process output was truncated.'
					: 'Compilation failed.';
				// After a failure the editor keeps the last successful listing.
				return this.shown ? `${failure} Showing the last successful output; hover for details.` : failure;
			}
			case 'successful':
				return this.truncated ? 'Artifact output was truncated.' : undefined;
		}
	}
}

const maximumHoverLength = 4_000;

/** The note for an artifact whose source has unsaved changes. */
export const unsavedSourceText = 'Source has unsaved changes. The artifact shows the saved file.';

/** The note for unsaved changes, with the reason why the compile read the saved file, if there is one. */
export function unsavedSourceNote(savedFileReason?: string): string {
	return savedFileReason
		? `Source has unsaved changes. ${savedFileReason} The artifact shows the saved file.`
		: unsavedSourceText;
}

function clearDecorations(editor: TextEditor, decorations: readonly TextEditorDecorationType[]): void {
	for (const decoration of decorations) {
		editor.setDecorations(decoration, []);
	}
}

/**
 * An artifact whose main-source lines are moved through the shift. A line whose source line an edit
 * removed has no source. A range keeps its end only when the end line still exists.
 */
function movedArtifact(
	artifact: RenderedTextArtifact,
	shift: LineShift,
	isMainSourceFile: (file: string) => boolean,
): RenderedTextArtifact {
	return {
		...artifact,
		lines: artifact.lines.map((line): RenderedArtifactLine => {
			const source = line.source;
			if (!source?.file || source.line === null || source.line === undefined || !isMainSourceFile(source.file)) {
				return line;
			}
			const moved = shift.lineOf(source.line - 1);
			if (moved === undefined) {
				return { ...line, source: null };
			}
			const { endLine, endColumn, ...start } = source;
			const end = endLine === undefined ? undefined : shift.lineOf(endLine - 1);
			return {
				...line,
				source: {
					...start,
					line: moved + 1,
					...(end !== undefined && end >= moved && endColumn !== undefined
						? { endLine: end + 1, endColumn }
						: {}),
				},
			};
		}),
	};
}

function sourceSelectionRange(document: TextDocument, line: RenderedArtifactLine): Range | undefined {
	const source = line.source;
	if (
		source?.line === null ||
		source?.line === undefined ||
		source.endLine === undefined ||
		source.endColumn === undefined
	) {
		return undefined;
	}
	const startLine = source.line - 1;
	const endLine = source.endLine - 1;
	if (startLine < 0 || endLine < startLine || endLine >= document.lineCount) {
		return undefined;
	}
	const startCharacter = Math.min(Math.max(0, source.column ?? 0), document.lineAt(startLine).text.length);
	const endCharacter = Math.min(Math.max(0, source.endColumn), document.lineAt(endLine).text.length);
	if (endLine === startLine && endCharacter <= startCharacter) {
		return undefined;
	}
	return new Range(startLine, startCharacter, endLine, endCharacter);
}
