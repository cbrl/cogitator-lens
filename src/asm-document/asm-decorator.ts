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
import { asmLineHasSource, type CompiledAssembly } from './compiled-assembly.js';
import path from 'path';
import { equalUri } from '../utils.js';
import {
	optimizationRemarkDecorations,
	selectedLineDecoration,
	selectedSourceRangeDecoration,
	stateDecoration,
	unusedLineDecoration,
} from './decorations/decoration-styles.js';
import { EditorTracker } from './decorations/editor-tracker.js';
import type { ConfigurationService } from '../services/configuration-service.js';
import type { CompileHandlerStatus, CompilationDocumentState } from './compile-handler.js';
import type { RenderedArtifactLine } from '../types/index.js';

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
 * lines between source and assembly. Each instance of AsmDecorator is associated with one assembly document and its
 * referenced source documents.
 *
 * Decorations are only active when the assembly document is visible along with at least one of its referenced source
 * documents.
 */
export class AsmDecorator {
	private readonly srcUri: Uri;
	private readonly asmUri: Uri;

	private asmData: CompiledAssembly | Error | undefined;
	private compilationState: CompilationDocumentState = 'stale';
	private truncated = false;

	private readonly editorTracker: EditorTracker;
	private readonly configService: ConfigurationService;
    private readonly registrations: Disposable;

	private active: boolean = true;
	private isDisposed: boolean = false;

    constructor(
		srcUri: Uri,
		asmUri: Uri,
		asmEvent: Event<CompileHandlerStatus>,
		configService: ConfigurationService,
	) {
		this.asmUri = asmUri;
		this.srcUri = srcUri;
		this.editorTracker = new EditorTracker();
		this.configService = configService;

        this.refreshDecorations();

        // Rebuild mapping and decorations on asm document change
        const providerEventRegistration = asmEvent(status => {
			this.compilationState = status.state;
			this.truncated = status.truncated;
			if (status.assembly) {
				this.asmData = status.assembly;
			} else if (status.error) {
				this.asmData = status.error;
			}
			this.refreshDecorations();
        });

		const visibilityChangeRegistration = window.onDidChangeVisibleTextEditors(this.onChangeVisibleEditors.bind(this));

		const selectionChangeRegistration = window.onDidChangeTextEditorSelection(this.onEditorSelectionChanged.bind(this));

		const documentChangeRegistration = workspace.onDidChangeTextDocument(event => {
			if (equalUri(event.document.uri, this.asmUri)) {
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

		if (!this.asmData || this.asmData instanceof Error) {
			return;
		}

		if (this.asmData.allReferencedSrcUris.has(event.textEditor.document.uri)) {
			this.onSrcLineSelected(event.textEditor);
		}
		else if (equalUri(event.textEditor.document.uri, this.asmUri)) {
			this.onAsmLineSelected(event.textEditor);
		}
    }

    private refreshDecorations() {
		this.clearAllDecorations();

		if (this.asmData && !(this.asmData instanceof Error)) {
			// Recalculate active state now that asmData may have changed
			this.updateActiveState();
			this.dimUnusedSourceLines();
			this.decorateOptimizationRemarks();
		}

		// Treat as if the user selected the current line of the first editor (only highlights the line, doesn't scroll)
		// TODO: use active editor instead of the first visible source editor?
		if (this.asmData && !(this.asmData instanceof Error) && this.asmData.lines.length > 0) {
			const sourceEditor = this.getAllSourceEditors()[0];
			if (sourceEditor) {
				this.onSrcLineSelected(sourceEditor, true);
			}
		}

		const stateText = this.stateDecorationText();
		if (stateText) {
			const asmEditor = this.editorTracker.getAsmEditor(this.asmUri);
			asmEditor?.setDecorations(stateDecoration, [{
				range: new Range(0, 0, 0, 0),
				renderOptions: {
					after: { contentText: ` ${stateText}` },
				},
			}]);
		}
	}

	private clearDecorations(editor: TextEditor) {
		editor.setDecorations(selectedLineDecoration, []);
		editor.setDecorations(selectedSourceRangeDecoration, []);
		editor.setDecorations(unusedLineDecoration, []);
		editor.setDecorations(stateDecoration, []);
		for (const decoration of Object.values(optimizationRemarkDecorations)) {
			editor.setDecorations(decoration, []);
		}
	}

	private clearAllDecorations() {
		for (let editor of this.getAllSourceEditors()) {
			this.clearDecorations(editor);
		}

		const asmEditor = this.editorTracker.getAsmEditor(this.asmUri);
		if (asmEditor !== undefined) {
			this.clearDecorations(asmEditor);
		}
	}

    private dimUnusedSourceLines() {
		if (!this.asmData || this.asmData instanceof Error) {
			return;
		}
		const asmData = this.asmData;
		const getUnusedLines = (document: TextDocument) => {
			const unusedLines: Range[] = [];

			const map = asmData.sourceLineMappings.get(document.uri);
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

    private onSrcLineSelected(selectedEditor: TextEditor, highlightOnly: boolean = false): void {
		if (!this.asmData || this.asmData instanceof Error) {
			return;
		}

		const asmEditor = this.editorTracker.getAsmEditor(this.asmUri);

		if (asmEditor === undefined) {
			return;
		}

		const asmData = this.asmData;
		const getSelectedLines = (srcFile: Uri, line: number) => {
			const asmLinesRanges: Range[] = [];
			const mapped = asmData.sourceLineMappings.get(srcFile)?.get(line);

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
		if (!this.asmData || this.asmData instanceof Error) {
			return;
		}

		const line = asmEditor.selection.start.line;
		if (line < 0 || line >= this.asmData.lines.length || line >= asmEditor.document.lineCount) {
			return;
		}
        const asmLine = this.asmData.lines[line];

		// Highlight selected line in ASM editor
        const asmLineRange = asmEditor.document.lineAt(line).range;
        asmEditor.setDecorations(selectedLineDecoration, [asmLineRange]);
		asmEditor.setDecorations(selectedSourceRangeDecoration, []);

		// Highlight associated lines in source editor
        if (asmLineHasSource(asmLine)) {
			const srcUri = Uri.file(path.normalize(asmLine.source!.file!));

			// Open the correct source document if this line of assembly refers to a different file
			this.getOrCreateSourceEditor(srcUri).then(targetEditor => {
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
		if (!this.asmData || this.asmData instanceof Error) {
			this.active = false;
			return;
		}

		const srcUris = this.asmData.allReferencedSrcUris;
		const editors = window.visibleTextEditors;

		// Active if the assembly editor is visible and one of the associated source editors is visible
		const hasAsmEditor = editors.some(editor => equalUri(editor.document.uri, this.asmUri));
		const hasAnySourceEditor = editors.some(e => srcUris.has(e.document.uri));

		this.active = hasAsmEditor && hasAnySourceEditor;
	}

	private decorateOptimizationRemarks(): void {
		if (!this.asmData || this.asmData instanceof Error) {
			return;
		}
		const editor = this.editorTracker.getAsmEditor(this.asmUri);
		if (!editor) {
			return;
		}
		for (const [category, decoration] of Object.entries(optimizationRemarkDecorations)) {
			const options = this.asmData.lines.flatMap((line, index) => {
				if (index >= editor.document.lineCount) {
					return [];
				}
				const remarks = line.decorations?.filter(candidate =>
					candidate.kind === 'optimization-remark'
					&& candidate.category === category) ?? [];
				if (remarks.length === 0) {
					return [];
				}
				const end = editor.document.lineAt(index).range.end;
				return [{
					range: new Range(end, end),
					renderOptions: {
						after: {
							contentText: remarks.map(remark => remark.text).join(' · '),
						},
					},
				}];
			});
			editor.setDecorations(decoration, options);
		}
	}

	private onChangeVisibleEditors(): void {
		this.refreshDecorations();
		this.updateActiveState();

		if (this.active) {
			// Update dimmed lines when the editors change
			this.dimUnusedSourceLines();
		}
		else {
			// Clear all decorations if no longer active. An editor that goes out of view will automatically have
			// its decorations cleared, but the corresponding source/assembly editor won't if it's still visible.
			this.clearAllDecorations();
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
		if (!this.asmData || this.asmData instanceof Error) {
			return [];
		}

		return this.editorTracker.getSourceEditors(this.asmData.allReferencedSrcUris);
	}

	private stateDecorationText(): string | undefined {
		switch (this.compilationState) {
			case 'compiling':
				return 'Compiling…';
			case 'stale':
				return 'Assembly is stale. Refresh pending.';
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
