import { TextEditor, window, TextEditorDecorationType, Range, ThemeColor, workspace, Event, Uri, Disposable, TextEditorRevealType, TextDocument, ViewColumn, TextEditorSelectionChangeEvent } from 'vscode';
import { CompiledAssembly } from './compiled-assembly';
import { ParsedAsmResultLine } from '../parsers/asmresult.interfaces';
import _ from 'underscore';
import path from 'path';
import { equalUri } from '../utils';
import assert from 'assert';

/*
Nice-to-have features:
 - Hover line in ASM/source editor highlights corresponding source/ASM line(s) (only on currently visible files, doesn't open new ones)
   - VSCode API doesn't appear to expose the line hovered by the mouse
 - Ctrl-click opens corresponding editor (if not open) then highlights lines
   - VSCode has an 8+ year old issue (#3130) for adding mouse shortcut customization
   - Definition provider seems like the best way to do this for now
     - The UX for this isn't ideal unless the user changes VS Code settings to open definitions in an existing editor (can some ugly hacks work around this?)
*/

export class AsmDecorator {
	private readonly srcUri: Uri;
	private readonly asmUri: Uri;

    private asmData: CompiledAssembly | Error;

    private readonly selectedLineDecoration: TextEditorDecorationType;
    private readonly unusedLineDecoration: TextEditorDecorationType;
	private readonly loadingDecoration: TextEditorDecorationType;
    private readonly registrations: Disposable;

	private active: boolean = true;

    constructor(srcUri: Uri, asmUri: Uri, asmEvent: Event<CompiledAssembly | Error>) {
		this.asmUri = asmUri;
		this.srcUri = srcUri;
		this.asmData = new CompiledAssembly(this.srcUri, this.asmUri, []);

        this.selectedLineDecoration = window.createTextEditorDecorationType({
            isWholeLine: true,
            backgroundColor: new ThemeColor('editor.findMatchHighlightBackground'),
            overviewRulerColor: new ThemeColor('editorOverviewRuler.findMatchForeground')
        });

        this.unusedLineDecoration = window.createTextEditorDecorationType({
            opacity: '0.5'
        });

        this.loadingDecoration = window.createTextEditorDecorationType({
            after: {
                contentText: ' ⏳ Compiling...',
                color: 'gray'
            }
        });

        this.refreshDecorations();

        // Rebuild mapping and decorations on asm document change
        const providerEventRegistration = asmEvent((resultOrError) => {
			this.asmData = resultOrError;
			this.refreshDecorations();
        });

		const visibilityChangeRegistration = window.onDidChangeVisibleTextEditors(this.onChangeVisibleEditors.bind(this));

		const selectionChangeRegistration = window.onDidChangeTextEditorSelection(this.onEditorSelectionChanged.bind(this));

		const documentCloseRegistration = workspace.onDidCloseTextDocument(document => {
			// Dispose of decorator if ASM window was closed
			if (document.uri === this.asmUri) {
				this.dispose();
			}
		});

        this.registrations = Disposable.from(
            this.selectedLineDecoration,
            this.unusedLineDecoration,
            providerEventRegistration,
			visibilityChangeRegistration,
            selectionChangeRegistration,
            documentCloseRegistration
        );
    }

    public dispose(): void {
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

		if (this.asmData instanceof Error) {
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

		// If the ASM document failed to compile, then don't decorate anything.
		if (this.asmData instanceof Error) {
			return;
		}

		this.dimUnusedSourceLines();

		// Treat as if the user selected the current line of the first editor (only highlights the line, doesn't scroll)
		// TODO: use active editor instead of the first visible source editor?
		if (this.asmData.lines.length > 0) {
			this.onSrcLineSelected(this.getAllSourceEditors()[0], true);
		}

		// If the ASM document is empty, show a loading decoration.
		// TODO: detect compile state instead of just checking line count
		if (this.asmData.lines.length === 0) {
			getEditor(this.asmUri)?.setDecorations(this.loadingDecoration, [new Range(0, 0, 0, 0)]);
		}
	}

    private asmLineHasSource(asmLine: ParsedAsmResultLine) {
        // eslint-disable-next-line eqeqeq
        return (asmLine.source?.file != null && asmLine.source?.line != null); //checks null or undefined
    }

	private clearDecorations(editor: TextEditor) {
		editor.setDecorations(this.selectedLineDecoration, []);
		editor.setDecorations(this.unusedLineDecoration, []);
		editor.setDecorations(this.loadingDecoration, []);
	}

	private clearAllDecorations() {
		for (let editor of this.getAllSourceEditors()) {
			this.clearDecorations(editor);
		}

		const asmEditor = getEditor(this.asmUri);
		if (asmEditor !== undefined) {
			this.clearDecorations(asmEditor);
		}
	}

    private dimUnusedSourceLines() {
		const getUnusedLines = (document: TextDocument) => {
			assert(this.asmData instanceof CompiledAssembly);

			const unusedLines: Range[] = [];

			const map = this.asmData.getSourceToAsmLineMapping(document.uri);
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
			const config = workspace.getConfiguration('', editor.document);
			const dimUnused = config.get('coglens.dimUnusedSourceLines', true);

			if (dimUnused) {
				editor.setDecorations(this.unusedLineDecoration, getUnusedLines(editor.document));
			}
		}
    }

    private onSrcLineSelected(selectedEditor: TextEditor, highlightOnly: boolean = false): void {
		if (this.asmData instanceof Error) {
			return;
		}

		const asmEditor = getEditor(this.asmUri);

		if (asmEditor === undefined) {
			return;
		}

		const getSelectedLines = (srcFile: Uri, line: number) => {
			assert(this.asmData instanceof CompiledAssembly);

			const asmLinesRanges: Range[] = [];
			const mapped = this.asmData.getSourceLinesForAsmLine(srcFile, line);

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
        selectedEditor.setDecorations(this.selectedLineDecoration, [srcLineRange]);

		// Highlight associated lines in ASM editor
		const asmLines: Range[] = getSelectedLines(selectedEditor.document.uri, selectedEditor.selection.start.line);

		for (let editor of this.getAllSourceEditors()) {
			if (editor !== selectedEditor) {
				asmLines.push(...getSelectedLines(editor.document.uri, editor.selection.start.line));
			}
		}

        asmEditor.setDecorations(this.selectedLineDecoration, asmLines);

        if (asmLines.length > 0 && !highlightOnly) {
			// First line will be from the editor that actually had its selection changed (the editor passed to this function)
            asmEditor.revealRange(asmLines[0], TextEditorRevealType.InCenterIfOutsideViewport);
        }
    }

    private onAsmLineSelected(asmEditor: TextEditor, highlightOnly: boolean = false): void {
		if (this.asmData instanceof Error) {
			return;
		}

		const line = asmEditor.selection.start.line;
        const asmLine = this.asmData.lines[line];

		// Highlight selected line in ASM editor
        const asmLineRange = asmEditor.document.lineAt(line).range;
        asmEditor.setDecorations(this.selectedLineDecoration, [asmLineRange]);

		// Highlight associated lines in source editor
        if (this.asmLineHasSource(asmLine)) {
			const srcUri = Uri.file(path.normalize(asmLine.source!.file!));

			// Open the correct source document if this line of assembly refers to a different file
			this.getOrCreateSourceEditor(srcUri).then(targetEditor => {
				const srcLineRange = targetEditor.document.lineAt(asmLine.source!.line! - 1).range;

				targetEditor.setDecorations(this.selectedLineDecoration, [srcLineRange]);

				if (!highlightOnly) {
					targetEditor.revealRange(srcLineRange, TextEditorRevealType.InCenterIfOutsideViewport);
				}
			});
        }
		else {
			// Clear selected line decoration when the assembly editor line doesn't correspond to a source location
			for (let editor of this.getAllSourceEditors()) {
				editor.setDecorations(this.selectedLineDecoration, []);
			}
        }
    }

	private onChangeVisibleEditors(editors: readonly TextEditor[]): void {
		if (this.asmData instanceof Error) {
			return;
		}

		const srcUris = this.asmData.allReferencedSrcUris;

		// Active if the assembly editor is visible and one of the associated source editors is visible
		const hasAsmEditor = editors.find(editor => equalUri(editor.document.uri, this.asmUri)) !== undefined;
		const hasAnySourceEditor = _.any(editors.map(e => srcUris.has(e.document.uri)));

		this.active = hasAsmEditor && hasAnySourceEditor;

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
		// Doesn't do anything if the document was already opened
		const document = await workspace.openTextDocument(uri);

		const visibleSrcEditors = this.getAllSourceEditors();

		// Check if the document is already open in a visible source editor
		let editor = visibleSrcEditors.find(editor => editor.document === document);

		// Open an editor for the document if it isn't open or visible
		if (editor === undefined) {
			// Open on the same column as the first visible source editor, or on the first column if no editors are open.
			const column = (visibleSrcEditors.length > 0) ? visibleSrcEditors[0].viewColumn : ViewColumn.One;

			editor = await window.showTextDocument(document, {
				viewColumn: column,
				preserveFocus: true //don't put focus on the new editor
			});

			visibleSrcEditors.push(editor);
		}

		return editor;
	}

	private getAllSourceEditors(): TextEditor[] {
		if (this.asmData instanceof Error) {
			return [];
		}

		const srcUris = this.asmData.allReferencedSrcUris;

		// It would be great if we could just store text editors and use those everywhere instead
		// of URIs or documents, but the text editor objects are not stable. For example, switching
		// from one tab to another then back to the first tab will most likely create an entirely
		// new editor object, even though it's the same underlying document.
		return window.visibleTextEditors.filter(editor => srcUris.has(editor.document.uri));
	}
}

function getEditor(uri: Uri): TextEditor | undefined {
	return window.visibleTextEditors.find(editor => equalUri(editor.document.uri, uri));
}
