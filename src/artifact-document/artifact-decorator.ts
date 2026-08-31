import {
	Disposable,
	Event,
	Range,
	TextDocument,
	TextEditor,
	TextEditorRevealType,
	TextEditorSelectionChangeEvent,
	Uri,
	window,
	workspace,
} from 'vscode';
import { asmLineHasSource, type ArtifactDocumentContent } from './artifact-document-content.js';
import path from 'path';
import { equalUri } from '../utils.js';
import {
	binaryColumnsDecoration,
	optimizationRemarkDecorations,
	stackUsageDecoration,
	selectedLineDecoration,
	selectedSourceRangeDecoration,
	stateDecoration,
	sourceLineBandDecorations,
	unusedLineDecoration,
} from './decorations/decoration-styles.js';
import { EditorTracker } from './decorations/editor-tracker.js';
import type { ConfigurationService } from '../services/configuration-service.js';
import type { ArtifactStatus, ArtifactState } from './artifact-generator.js';
import type {
	ArtifactKind,
	ArtifactOptions,
	OptimizationRemarkLineAnnotation,
	RenderedArtifactLine,
	StackUsageLineAnnotation,
} from '../types/index.js';
import { formatArtifactLineAnnotation } from '../artifacts/analysis/analysis-source-renderer.js';
import { artifactSupportsOption } from '../artifacts/core/artifact-definitions.js';

/*
Nice-to-have features:
 - Hover line in ASM/source editor highlights corresponding source/ASM line(s) (only on currently visible files, doesn't open new ones)
   - VSCode API doesn't appear to expose the line hovered by the mouse
 - Ctrl-click opens corresponding editor (if not open) then highlights lines
   - VSCode has a 10+ year old issue (#3130) for adding mouse shortcut customization
   - Definition provider seems like the best way to do this for now
     - The UX for this isn't ideal unless the user changes VS Code settings to open definitions in an existing editor (can some ugly hacks work around this?)
*/

/**
 * Manages decorations for assembly documents, including dimming unused source lines and highlighting corresponding
 * lines between source and assembly. Each instance of ArtifactDecorator is associated with one assembly document and its
 * referenced source documents.
 *
 * Decorations are only active when the assembly document is visible along with at least one of its referenced source
 * documents.
 */
export class ArtifactDecorator {
	private readonly sourceUri: Uri;
	private readonly artifactUri: Uri;

	private content: ArtifactDocumentContent | Error | undefined;
	private compilationState: ArtifactState = 'stale';
	private truncated = false;

	private readonly editorTracker: EditorTracker;
	private readonly configService: ConfigurationService;
    private readonly registrations: Disposable;

	private active: boolean = true;
	private isDisposed: boolean = false;

    constructor(
		sourceUri: Uri,
		artifactUri: Uri,
		asmEvent: Event<ArtifactStatus>,
		configService: ConfigurationService,
		private readonly artifactOptions: (kind: ArtifactKind) => ArtifactOptions,
	) {
		this.artifactUri = artifactUri;
		this.sourceUri = sourceUri;
		this.editorTracker = new EditorTracker();
		this.configService = configService;

        this.refreshDecorations();

        // Rebuild mapping and decorations on asm document change
        const providerEventRegistration = asmEvent(status => {
			this.compilationState = status.state;
			this.truncated = status.truncated;
			if (status.assembly) {
				this.content = status.assembly;
			} else if (status.error) {
				this.content = status.error;
			}
			this.refreshDecorations();
        });

		const visibilityChangeRegistration = window.onDidChangeVisibleTextEditors(this.onChangeVisibleEditors.bind(this));

		const selectionChangeRegistration = window.onDidChangeTextEditorSelection(this.onEditorSelectionChanged.bind(this));

		const documentChangeRegistration = workspace.onDidChangeTextDocument(event => {
			if (equalUri(event.document.uri, this.artifactUri)) {
				this.refreshDecorations();
			}
		});

        this.registrations = Disposable.from(
            providerEventRegistration,
			visibilityChangeRegistration,
            selectionChangeRegistration,
			documentChangeRegistration,
        );
    }

    public dispose(): void {
		this.isDisposed = true;
		this.clearAllDecorations();
        this.registrations.dispose();
    }

    public onEditorSelectionChanged(event: TextEditorSelectionChangeEvent): void {
		// This event will fire when an editor is opened as well, in which case the kind will be undefined. We don't
		// want to process that event, since it would act as if the user clicked whichever line happens to be selected
		// in that new editor when it opens. This would cause problems when the selected ASM line causes a new source
		// editor to open, since it would override the line that the user selected with the line that was selected when
		// the new editor opened.
		if (event.kind === undefined || !this.active) {
			return;
		}

		if (!this.content || this.content instanceof Error) {
			return;
		}

		if (this.content.allReferencedSrcUris.has(event.textEditor.document.uri)) {
			this.onSrcLineSelected(event.textEditor);
		}
		else if (equalUri(event.textEditor.document.uri, this.artifactUri)) {
			this.onAsmLineSelected(event.textEditor);
		}
    }

    private refreshDecorations() {
		this.clearAllDecorations();

		if (this.content && !(this.content instanceof Error)) {
			// Recalculate active state now that content may have changed
			this.updateActiveState();
			this.dimUnusedSourceLines();
			this.decorateListingColumns();
			this.decorateSourceLineBands();
			this.decorateAnalysisAnnotations();
		}

		// Treat as if the user selected the current line of the first editor (only highlights the line, doesn't scroll)
		// TODO: use active editor instead of the first visible source editor?
		if (this.content && !(this.content instanceof Error) && this.content.lines.length > 0) {
			const sourceEditor = this.getAllSourceEditors()[0];
			if (sourceEditor) {
				this.onSrcLineSelected(sourceEditor, true);
			}
		}

		const stateText = this.stateDecorationText();
		if (stateText) {
			const asmEditor = this.editorTracker.getArtifactEditor(this.artifactUri);
			asmEditor?.setDecorations(stateDecoration, [{
				range: new Range(0, 0, 0, 0),
				renderOptions: {
					after: { contentText: ` ${stateText}` },
				},
			}]);
		}
	}

	private clearDecorations(editor: TextEditor) {
		this.clearMappingDecorations(editor);
		editor.setDecorations(stateDecoration, []);
		editor.setDecorations(binaryColumnsDecoration, []);
		for (const decoration of Object.values(optimizationRemarkDecorations)) {
			editor.setDecorations(decoration, []);
		}
		editor.setDecorations(stackUsageDecoration, []);
	}

	private clearMappingDecorations(editor: TextEditor): void {
		editor.setDecorations(selectedLineDecoration, []);
		editor.setDecorations(selectedSourceRangeDecoration, []);
		editor.setDecorations(unusedLineDecoration, []);
		for (const decoration of sourceLineBandDecorations) {
			editor.setDecorations(decoration, []);
		}
	}

	private clearAllDecorations() {
		for (let editor of this.getAllSourceEditors()) {
			this.clearDecorations(editor);
		}

		const asmEditor = this.editorTracker.getArtifactEditor(this.artifactUri);
		if (asmEditor !== undefined) {
			this.clearDecorations(asmEditor);
		}
	}

    private dimUnusedSourceLines() {
		if (!this.content || this.content instanceof Error) {
			return;
		}
		const content = this.content;
		const getUnusedLines = (document: TextDocument) => {
			const unusedLines: Range[] = [];

			const map = content.sourceLineMappings.get(document.uri);
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

	private decorateListingColumns(): void {
		if (!this.content || this.content instanceof Error) {
			return;
		}
		const editor = this.editorTracker.getArtifactEditor(this.artifactUri);
		if (!editor || !this.artifactOptions(this.content.kind).display.binaryColumns) {
			return;
		}
		const addressWidth = Math.max(4, ...this.content.lines.map(line =>
			line.address === undefined ? 0 : line.address.toString(16).length));
		const opcodeWidth = Math.max(0, ...this.content.lines.map(line =>
			line.opcodes?.join(' ').length ?? 0));
		const options = this.content.lines.flatMap((line, index) => {
			if (
				index >= editor.document.lineCount
				|| (line.address === undefined && !line.opcodes?.length)
			) {
				return [];
			}
			const address = line.address === undefined
				? ''.padStart(addressWidth)
				: line.address.toString(16).padStart(addressWidth, '0');
			const opcodes = (line.opcodes?.join(' ') ?? '').padEnd(opcodeWidth);
			return [{
				range: new Range(index, 0, index, 0),
				renderOptions: { before: { contentText: `${address}  ${opcodes}` } },
			}];
		});
		editor.setDecorations(binaryColumnsDecoration, options);
	}

	private decorateSourceLineBands(): void {
		if (
			!this.content
			|| this.content instanceof Error
			|| !artifactSupportsOption(this.content.kind, 'sourceLineColorBands')
			|| !this.artifactOptions(this.content.kind).display.sourceLineColorBands
		) {
			return;
		}
		const asmEditor = this.editorTracker.getArtifactEditor(this.artifactUri);
		if (!asmEditor) {
			return;
		}
		const asmRanges = sourceLineBandDecorations.map(() => [] as Range[]);
		for (const editor of this.getAllSourceEditors()) {
			const sourceRanges = sourceLineBandDecorations.map(() => [] as Range[]);
			for (const [sourceLine, artifactLines] of
				this.content.sourceLineMappings.get(editor.document.uri) ?? []) {
				const band = sourceLine % sourceLineBandDecorations.length;
				if (sourceLine >= 0 && sourceLine < editor.document.lineCount) {
					sourceRanges[band].push(editor.document.lineAt(sourceLine).range);
				}
				for (const artifactLine of artifactLines) {
					if (artifactLine >= 0 && artifactLine < asmEditor.document.lineCount) {
						asmRanges[band].push(asmEditor.document.lineAt(artifactLine).range);
					}
				}
			}
			sourceLineBandDecorations.forEach((decoration, index) =>
				editor.setDecorations(decoration, sourceRanges[index]));
		}
		sourceLineBandDecorations.forEach((decoration, index) =>
			asmEditor.setDecorations(decoration, asmRanges[index]));
	}

    private onSrcLineSelected(selectedEditor: TextEditor, highlightOnly: boolean = false): void {
		if (!this.content || this.content instanceof Error) {
			return;
		}

		const asmEditor = this.editorTracker.getArtifactEditor(this.artifactUri);

		if (asmEditor === undefined) {
			return;
		}

		const content = this.content;
		const getSelectedLines = (srcFile: Uri, line: number) => {
			const asmLinesRanges: Range[] = [];
			const mapped = content.sourceLineMappings.get(srcFile)?.get(line);

			if (mapped !== undefined) {
				for (let line of mapped) {
					if (line >= asmEditor.document.lineCount) {
						continue;
					}
					asmLinesRanges.push(asmEditor.document.lineAt(line).range);
				}
			}

			return asmLinesRanges;
		};

		// Highlight selected line in source editor
        const srcLineRange = selectedEditor.document.lineAt(selectedEditor.selection.start.line).range;
		selectedEditor.setDecorations(selectedSourceRangeDecoration, []);
        selectedEditor.setDecorations(selectedLineDecoration, [srcLineRange]);

		// Highlight associated lines in ASM editor
		const asmLines: Range[] = getSelectedLines(selectedEditor.document.uri, selectedEditor.selection.start.line);

		for (let editor of this.getAllSourceEditors()) {
			if (editor !== selectedEditor) {
				asmLines.push(...getSelectedLines(editor.document.uri, editor.selection.start.line));
			}
		}

        asmEditor.setDecorations(selectedLineDecoration, asmLines);

        if (asmLines.length > 0 && !highlightOnly) {
			// First line will be from the editor that actually had its selection changed (the editor passed to this function)
            asmEditor.revealRange(asmLines[0], TextEditorRevealType.InCenterIfOutsideViewport);
        }
    }

    private onAsmLineSelected(asmEditor: TextEditor, highlightOnly: boolean = false): void {
		if (!this.content || this.content instanceof Error) {
			return;
		}

		const line = asmEditor.selection.start.line;
		if (line < 0 || line >= this.content.lines.length || line >= asmEditor.document.lineCount) {
			return;
		}
        const asmLine = this.content.lines[line];

		// Highlight selected line in ASM editor
        const asmLineRange = asmEditor.document.lineAt(line).range;
        asmEditor.setDecorations(selectedLineDecoration, [asmLineRange]);
		asmEditor.setDecorations(selectedSourceRangeDecoration, []);

		// Highlight associated lines in source editor
        if (asmLineHasSource(asmLine)) {
			const sourceUri = Uri.file(path.normalize(asmLine.source!.file!));

			// Open the correct source document if this line of assembly refers to a different file
			this.getOrCreateSourceEditor(sourceUri).then(targetEditor => {
				if (this.isDisposed || asmEditor.selection.start.line !== line) {
					return;
				}

				const srcLineIndex = asmLine.source!.line! - 1;
				if (srcLineIndex < 0 || srcLineIndex >= targetEditor.document.lineCount) {
					return;
				}

				const preciseRange = sourceSelectionRange(targetEditor.document, asmLine);
				const srcLineRange = preciseRange
					?? targetEditor.document.lineAt(srcLineIndex).range;
				for (const editor of this.getAllSourceEditors()) {
					editor.setDecorations(selectedLineDecoration, []);
					editor.setDecorations(selectedSourceRangeDecoration, []);
				}
				targetEditor.setDecorations(
					preciseRange ? selectedSourceRangeDecoration : selectedLineDecoration,
					[srcLineRange],
				);

				if (!highlightOnly) {
					targetEditor.revealRange(srcLineRange, TextEditorRevealType.InCenterIfOutsideViewport);
				}
			}).catch(() => {
				// Source file may no longer exist or be accessible
			});
        }
		else {
			// Clear selected line decoration when the assembly editor line doesn't correspond to a source location
			for (let editor of this.getAllSourceEditors()) {
				editor.setDecorations(selectedLineDecoration, []);
				editor.setDecorations(selectedSourceRangeDecoration, []);
			}
        }
    }

	private updateActiveState(): void {
		if (!this.content || this.content instanceof Error) {
			this.active = false;
			return;
		}

		const sourceUris = this.content.allReferencedSrcUris;
		const editors = window.visibleTextEditors;

		// Active if the assembly editor is visible and one of the associated source editors is visible
		const hasAsmEditor = editors.some(editor => equalUri(editor.document.uri, this.artifactUri));
		const hasAnySourceEditor = editors.some(e => sourceUris.has(e.document.uri));

		this.active = hasAsmEditor && hasAnySourceEditor;
	}

	private decorateAnalysisAnnotations(): void {
		if (!this.content || this.content instanceof Error) {
			return;
		}
		const editor = this.editorTracker.getArtifactEditor(this.artifactUri);
		if (!editor) {
			return;
		}
		for (const [category, decoration] of Object.entries(optimizationRemarkDecorations)) {
			const options = this.content.lines.flatMap((line, index) => {
				if (index >= editor.document.lineCount) {
					return [];
				}
				const remarks = line.annotations?.filter(
					(candidate): candidate is OptimizationRemarkLineAnnotation =>
					candidate.kind === 'optimization-remark'
					&& candidate.category === category,
				) ?? [];
				if (remarks.length === 0) {
					return [];
				}
				const end = editor.document.lineAt(index).range.end;
				return [{
					range: new Range(end, end),
						renderOptions: {
							after: {
							contentText: remarks.map(formatArtifactLineAnnotation).join(' · '),
						},
					},
				}];
			});
			editor.setDecorations(decoration, options);
		}

		const stackOptions = this.content.lines.flatMap((line, index) => {
			if (index >= editor.document.lineCount) {
				return [];
			}
			const entries = line.annotations?.filter(
				(candidate): candidate is StackUsageLineAnnotation =>
					candidate.kind === 'stack-usage',
			) ?? [];
			if (entries.length === 0) {
				return [];
			}
			const end = editor.document.lineAt(index).range.end;
			return [{
				range: new Range(end, end),
					renderOptions: {
						after: {
						contentText: entries.map(formatArtifactLineAnnotation).join(' · '),
					},
				},
			}];
		});
		editor.setDecorations(stackUsageDecoration, stackOptions);
	}

	private onChangeVisibleEditors(): void {
		this.refreshDecorations();
		this.updateActiveState();

		if (this.active) {
			// Update dimmed lines when the editors change
			this.dimUnusedSourceLines();
		}
		else {
			// Clear cross-editor mapping decorations if the pair is no longer visible. Listing-local columns,
			// analysis annotations, and state remain useful when the artifact is open by itself.
			for (const editor of this.getAllSourceEditors()) {
				this.clearDecorations(editor);
			}
			const asmEditor = this.editorTracker.getArtifactEditor(this.artifactUri);
			if (asmEditor) {
				this.clearMappingDecorations(asmEditor);
			}
		}
	}

	// Get the editor for a source document that is referenced by the current ASM document
	private async getOrCreateSourceEditor(uri: Uri): Promise<TextEditor> {
		return this.editorTracker.getOrCreateSourceEditor(uri, {
			viewColumn: this.getAllSourceEditors()[0]?.viewColumn,
			preserveFocus: true
		});
	}

	private getAllSourceEditors(): TextEditor[] {
		if (!this.content || this.content instanceof Error) {
			return [];
		}

		return this.editorTracker.getSourceEditors(this.content.allReferencedSrcUris);
	}

	private stateDecorationText(): string | undefined {
		switch (this.compilationState) {
			case 'compiling':
				return 'Compiling…';
			case 'stale':
				return 'Assembly is stale. Refresh pending.';
			case 'cancelled':
				return 'Artifact generation was cancelled.';
			case 'failed':
				return this.truncated
					? 'Compilation failed because process output was truncated.'
					: 'Compilation failed.';
			case 'successful':
				return this.truncated ? 'Assembly output was truncated.' : undefined;
		}
	}
}

function sourceSelectionRange(
	document: TextDocument,
	line: RenderedArtifactLine,
): Range | undefined {
	const source = line.source;
	if (
		source?.line === null
		|| source?.line === undefined
		|| source.endLine === undefined
		|| source.endColumn === undefined
	) {
		return undefined;
	}
	const startLine = source.line - 1;
	const endLine = source.endLine - 1;
	if (
		startLine < 0
		|| endLine < startLine
		|| endLine >= document.lineCount
	) {
		return undefined;
	}
	const startCharacter = Math.min(
		Math.max(0, source.column ?? 0),
		document.lineAt(startLine).text.length,
	);
	const endCharacter = Math.min(
		Math.max(0, source.endColumn),
		document.lineAt(endLine).text.length,
	);
	if (
		endLine === startLine
		&& endCharacter <= startCharacter
	) {
		return undefined;
	}
	return new Range(startLine, startCharacter, endLine, endCharacter);
}
