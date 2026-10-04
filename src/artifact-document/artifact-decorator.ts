import {
	Disposable,
	Event,
	Range,
	TextDocument,
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
import { equalUri } from '../file-identity.js';
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
import type { ArtifactStatus, ArtifactState } from './artifact-generator.js';
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

/*
Nice-to-have features:
 - Hover line in artifact/source editor highlights corresponding source/artifact line(s) (only on currently visible files, don't open new ones)
   - VSCode API doesn't appear to expose the line hovered by the mouse
 - Ctrl-click opens corresponding editor (if not open) then highlights lines
   - VSCode has a 10+ year old issue (#3130) for adding mouse shortcut customization
   - Definition provider seems like the best way to do this for now
     - The UX for this isn't ideal unless the user changes VS Code settings to open definitions in an existing editor (can some ugly hacks work around this?)
*/

/** A text artifact and the source map derived from it. */
interface MappedArtifact {
	readonly artifact: RenderedTextArtifact;
	readonly sources: SourceLineMap;
}

/**
 * Manages decorations for artifact documents, including dimming unused source lines and highlighting corresponding
 * lines between source and artifact. Each instance of ArtifactDecorator is associated with one artifact document and its
 * referenced source documents.
 *
 * Decorations are only active when the artifact document is visible along with at least one of its referenced source
 * documents.
 */
export class ArtifactDecorator {
	private readonly sourceUri: Uri;
	private readonly artifactUri: Uri;

	private content?: MappedArtifact;
	private compilationState: ArtifactState = 'stale';
	private truncated = false;

	private readonly configService: ConfigurationService;
	private readonly registrations: Disposable;

	private active: boolean = true;
	private readonly synchronizedScroll = new ScrollSyncSuppression<TextEditor>();

	constructor(
		sourceUri: Uri,
		artifactUri: Uri,
		statusEvent: Event<ArtifactStatus>,
		configService: ConfigurationService,
		private readonly artifactOptions: (kind: ArtifactKind) => ArtifactOptions,
	) {
		this.artifactUri = artifactUri;
		this.sourceUri = sourceUri;
		this.configService = configService;

		this.refreshDecorations();

		// Rebuild the source map when the artifact changes. A status keeps the last artifact while it
		// compiles, goes stale, or fails, so the decorations stay on the text the editor still shows.
		const providerEventRegistration = statusEvent((status) => {
			this.compilationState = status.state;
			this.truncated = status.truncated;
			const artifact = status.artifact?.presentation === 'text' ? status.artifact : undefined;
			if (artifact !== this.content?.artifact) {
				this.content = artifact && { artifact, sources: buildSourceLineMap(artifact) };
			}
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

		const documentChangeRegistration = workspace.onDidChangeTextDocument((event) => {
			if (equalUri(event.document.uri, this.artifactUri)) {
				this.refreshDecorations();
			}
		});

		this.registrations = Disposable.from(
			providerEventRegistration,
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
			if (content.sources.has(event.textEditor.document.uri)) {
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
			if (content.sources.has(event.textEditor.document.uri)) {
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

	private refreshDecorations() {
		this.clearAllDecorations();

		this.withContent((content) => {
			// Recalculate active state now that content may have changed
			this.updateActiveState(content);
			this.dimUnusedSourceLines(content);
			const { kind } = content.artifact;
			if (
				artifactSupportsOption(kind, 'sourceLineColorBands') &&
				this.artifactOptions(kind).display.sourceLineColorBands
			) {
				this.decorateSourceDensity(content);
				this.decorateSourceLineBands(content);
			}
			this.decorateListingColumns(content);
			this.decorateJumpArrows(content);
			this.decorateAnalysisAnnotations(content);

			// Treat as if the user selected the current line of the first editor (only highlights the line, doesn't scroll)
			// TODO: use active editor instead of the first visible source editor?
			if (content.artifact.lines.length > 0) {
				const sourceEditor = this.getAllSourceEditors(content)[0];
				if (sourceEditor) {
					this.onSrcLineSelected(content, sourceEditor, true);
				}
			}
		});

		const stateText = this.stateDecorationText();
		if (stateText) {
			const artifactEditor = this.artifactEditor();
			artifactEditor?.setDecorations(stateDecoration, [
				{
					range: new Range(0, 0, 0, 0),
					renderOptions: {
						after: { contentText: ` ${stateText}` },
					},
				},
			]);
		}
	}

	private clearAllDecorations() {
		const artifactEditor = this.artifactEditor();
		const editors = this.getAllSourceEditors();
		for (const editor of artifactEditor ? [...editors, artifactEditor] : editors) {
			clearDecorations(editor, allDecorations);
		}
	}

	private dimUnusedSourceLines(content: MappedArtifact) {
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

		for (let editor of this.getAllSourceEditors()) {
			const dimUnused = this.configService.getDimUnusedSourceLines(editor.document.uri);

			if (dimUnused) {
				editor.setDecorations(unusedLineDecoration, getUnusedLines(editor.document));
			}
		}
	}

	private decorateSourceDensity(content: MappedArtifact): void {
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
				bandDecorations.forEach((decoration, level) =>
					editor.setDecorations(decoration, decorations[band][level]),
				),
			);
		}
	}

	private decorateListingColumns(content: MappedArtifact): void {
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
		editor.setDecorations(binaryColumnsDecoration, options);
	}

	private decorateJumpArrows(content: MappedArtifact): void {
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
			editor.setDecorations(jumpArrowDecorations[direction].source, options[direction].source);
			editor.setDecorations(jumpArrowDecorations[direction].target, options[direction].target);
		}
	}

	private decorateSourceLineBands(content: MappedArtifact): void {
		const artifactEditor = this.artifactEditor();
		if (!artifactEditor) {
			return;
		}

		const artifactRanges = sourceLineBandDecorations.map(() => [] as Range[]);
		for (const editor of this.getAllSourceEditors()) {
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
			sourceLineBandDecorations.forEach((decoration, index) =>
				editor.setDecorations(decoration, sourceRanges[index]),
			);
		}
		sourceLineBandDecorations.forEach((decoration, index) =>
			artifactEditor.setDecorations(decoration, artifactRanges[index]),
		);
	}

	private onSrcLineSelected(
		content: MappedArtifact,
		selectedEditor: TextEditor,
		highlightOnly: boolean = false,
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
		selectedEditor.setDecorations(selectedSourceRangeDecoration, []);
		selectedEditor.setDecorations(selectedLineDecoration, [srcLineRange]);

		// Highlight associated lines in artifact editor
		const artifactLines: Range[] = getSelectedLines(
			selectedEditor.document.uri,
			selectedEditor.selection.start.line,
		);

		for (let editor of this.getAllSourceEditors()) {
			if (editor !== selectedEditor) {
				artifactLines.push(...getSelectedLines(editor.document.uri, editor.selection.start.line));
			}
		}

		artifactEditor.setDecorations(selectedLineDecoration, artifactLines);

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
				for (const editor of this.getAllSourceEditors()) {
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
		editor.revealRange(editor.document.lineAt(line).range, TextEditorRevealType.AtTop);
	}

	private revealNavigationTarget(editor: TextEditor, range: Range): void {
		if (editor.visibleRanges.some((visibleRange) => visibleRange.contains(range))) {
			return;
		}
		// A selection in one editor can scroll the other editor. Suppress the resulting
		// visible-range events so automatic scroll synchronization cannot navigate back
		// from an unrelated line that happens to be at the top of the new viewport.
		this.synchronizedScroll.begin(editor);
		editor.revealRange(range, TextEditorRevealType.InCenterIfOutsideViewport);
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

	private decorateAnalysisAnnotations(content: MappedArtifact): void {
		for (const [style, decoration] of Object.entries(annotationStyleDecorations)) {
			this.annotationDecorations(content, style, decoration);
		}
	}

	private annotationDecorations(content: MappedArtifact, style: string, decoration: TextEditorDecorationType): void {
		const editor = this.artifactEditor();
		if (!editor) {
			return;
		}
		const options = content.artifact.lines.flatMap((line, index) => {
			if (index >= editor.document.lineCount) {
				return [];
			}
			const annotations = line.annotations?.filter((annotation) => annotation.style === style) ?? [];
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
		editor.setDecorations(decoration, options);
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

	private getAllSourceEditors(content = this.content): TextEditor[] {
		return content ? window.visibleTextEditors.filter((editor) => content.sources.has(editor.document.uri)) : [];
	}

	private artifactEditor(): TextEditor | undefined {
		return window.visibleTextEditors.find((editor) => equalUri(editor.document.uri, this.artifactUri));
	}

	private withContent<T>(action: (content: MappedArtifact) => T): T | undefined {
		return this.content ? action(this.content) : undefined;
	}

	private stateDecorationText(): string | undefined {
		switch (this.compilationState) {
			case 'compiling':
				return 'Compiling…';
			case 'stale':
				return 'Artifact is stale. Refresh pending.';
			case 'cancelled':
				return 'Artifact generation was cancelled.';
			case 'failed':
				return this.truncated
					? 'Compilation failed because process output was truncated.'
					: 'Compilation failed.';
			case 'successful':
				return this.truncated ? 'Artifact output was truncated.' : undefined;
		}
	}
}

function clearDecorations(editor: TextEditor, decorations: readonly TextEditorDecorationType[]): void {
	for (const decoration of decorations) {
		editor.setDecorations(decoration, []);
	}
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
