import { TextEditor, window, TextEditorDecorationType, Range, ThemeColor, workspace, Uri, Disposable, TextEditorRevealType, TextDocument, ViewColumn, TextEditorSelectionChangeEvent } from 'vscode';
import { CompiledAssembly } from './compiled-assembly';
import { ParsedAsmResultLine } from '../parsers/asmresult.interfaces';
import _ from 'underscore';
import path from 'path';
import { equalUri } from '../utils';
import { UriSet } from '../uri-containers';

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

    private readonly asmData: CompiledAssembly;

	private readonly allSourceUris = new UriSet();

    private readonly selectedLineDecorationType: TextEditorDecorationType;
    private readonly unusedLineDecorationType: TextEditorDecorationType;
	private readonly loadingDecorationType: TextEditorDecorationType;
    private readonly registrations: Disposable;

	private active: boolean = true;

    // Mapping of source line to assembly line for each source file: file -> (source line -> ASM line)
    private readonly mappings = new Map<string, Map<number, number[]>>();

    constructor(asmData: CompiledAssembly) {
        this.asmData = asmData;
		this.asmUri = asmData.asmUri;
		this.srcUri = asmData.srcUri;

		this.allSourceUris.add(asmData.srcUri);

        this.selectedLineDecorationType = window.createTextEditorDecorationType({
            isWholeLine: true,
            backgroundColor: new ThemeColor('editor.findMatchHighlightBackground'),
            overviewRulerColor: new ThemeColor('editorOverviewRuler.findMatchForeground')
        });

        this.unusedLineDecorationType = window.createTextEditorDecorationType({
            opacity: '0.5'
        });

        this.loadingDecorationType = window.createTextEditorDecorationType({
            after: {
                contentText: ' ⏳ Compiling...',
                color: 'gray'
            }
        });

        this.loadMappings();
        this.refreshDecorations();

        // Rebuild mapping and decorations on asm document change
        const providerEventRegistration = asmData.onDidChange(() => {
            this.loadMappings();
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
            this.selectedLineDecorationType,
            this.unusedLineDecorationType,
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
		// We only want to handle the cases where the user manually selected a new line in the assembly or source
		// editor. Opening a new editor (e.g. the assembly document or a new source document) will also fire this
		// event, so processing all events without checking the kind would mean that opening a new editor would be
		// treated as if the user clicked whichever line happens to be selected in that new editor when it opens.
		// In the case where the user's selection in the assembly viewer caused a new editor to open, not checking
		// the event kind would make it override the line that the user selected with the line that was selected
		// when the editor opened. The event kind is undefined when fired due to an editor opening.
		if (event.kind === undefined || !this.active) {
			return;
		}

		if (this.allSourceUris.has(event.textEditor.document.uri)) {
			this.onSrcLineSelected(event.textEditor);
		}
		else if (equalUri(event.textEditor.document.uri, this.asmUri)) {
			this.onAsmLineSelected(event.textEditor);
		}
    }

    private refreshDecorations() {
		this.clearAllDecorations();

		this.dimUnusedSourceLines();

		// Treat as if the user selected the current line of the first editor (only highlights the line, doesn't scroll)
		// TODO: use active editor instead of the first visible source editor?
		if (this.asmData.lines.length > 0) {
			this.onSrcLineSelected(this.getAllSourceEditors()[0], true);
		}

		// If the ASM document is empty, show a loading decoration.
		// TODO: detect compile state instead of just checking line count
		if (this.asmData.lines.length === 0) {
			getEditor(this.asmUri)?.setDecorations(this.loadingDecorationType, [new Range(0, 0, 0, 0)]);
		}
	}

    private loadMappings() {
        this.mappings.clear();

        this.asmData.lines.forEach((line, index) => {
            if (!this.asmLineHasSource(line)) {
                return;
            }

			const sourceUri = Uri.file(path.normalize(line.source!.file!));
            const sourceLine = line.source!.line! - 1;

			this.allSourceUris.add(sourceUri);

			let lineMap = this.mappings.get(sourceUri.fsPath);
			if (lineMap === undefined) {
				lineMap = new Map();
				this.mappings.set(sourceUri.fsPath, lineMap);
			}
            if (lineMap.get(sourceLine) === undefined) {
                lineMap.set(sourceLine, []);
            }
            lineMap.get(sourceLine)!.push(index);
        });
    }

    private asmLineHasSource(asmLine: ParsedAsmResultLine) {
        // eslint-disable-next-line eqeqeq
        return (asmLine.source?.file != null && asmLine.source?.line != null); //checks null or undefined
    }

	private clearDecorations(editor: TextEditor) {
		editor.setDecorations(this.selectedLineDecorationType, []);
		editor.setDecorations(this.unusedLineDecorationType, []);
		editor.setDecorations(this.loadingDecorationType, []);
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
			const unusedLines: Range[] = [];

			const map = this.mappings.get(document.uri.fsPath);
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
				editor.setDecorations(this.unusedLineDecorationType, getUnusedLines(editor.document));
			}
		}
    }

    private onSrcLineSelected(selectedEditor: TextEditor, highlightOnly: boolean = false): void {
		const asmEditor = getEditor(this.asmUri);

		if (asmEditor === undefined) {
			return;
		}

		const getSelectedLines = (srcFile: string, line: number) => {
			const asmLinesRanges: Range[] = [];
			const mapped = this.mappings.get(srcFile)?.get(line);

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
        selectedEditor.setDecorations(this.selectedLineDecorationType, [srcLineRange]);

		// Highlight associated lines in ASM editor
		const asmLines: Range[] = getSelectedLines(selectedEditor.document.uri.fsPath, selectedEditor.selection.start.line);

		for (let editor of this.getAllSourceEditors()) {
			if (editor !== selectedEditor) {
				asmLines.push(...getSelectedLines(editor.document.uri.fsPath, editor.selection.start.line));
			}
		}

        asmEditor.setDecorations(this.selectedLineDecorationType, asmLines);

        if (asmLines.length > 0 && !highlightOnly) {
			// First line will be from the editor that actually had its selection changed (the editor passed to this function)
            asmEditor.revealRange(asmLines[0], TextEditorRevealType.InCenterIfOutsideViewport);
        }
    }

    private onAsmLineSelected(asmEditor: TextEditor, highlightOnly: boolean = false): void {
		const line = asmEditor.selection.start.line;
        const asmLine = this.asmData.lines[line];

		// Highlight selected line in ASM editor
        const asmLineRange = asmEditor.document.lineAt(line).range;
        asmEditor.setDecorations(this.selectedLineDecorationType, [asmLineRange]);

		// Highlight associated lines in source editor
        if (this.asmLineHasSource(asmLine)) {
			const srcUri = Uri.file(path.normalize(asmLine.source!.file!));

			// Open the correct source document if this line of assembly refers to a different file
			this.getOrCreateSourceEditor(srcUri).then(targetEditor => {
				const srcLineRange = targetEditor.document.lineAt(asmLine.source!.line! - 1).range;

				targetEditor.setDecorations(this.selectedLineDecorationType, [srcLineRange]);

				if (!highlightOnly) {
					targetEditor.revealRange(srcLineRange, TextEditorRevealType.InCenterIfOutsideViewport);
				}
			});
        }
		else {
			// Clear selected line decoration when the assembly editor line doesn't correspond to a source location
			for (let editor of this.getAllSourceEditors()) {
				editor.setDecorations(this.selectedLineDecorationType, []);
			}
        }
    }

	private onChangeVisibleEditors(editors: readonly TextEditor[]): void {
		// Active if the assembly editor is visible and one of the associated source editors is visible
		const hasAsmEditor = editors.find(editor => equalUri(editor.document.uri, this.asmUri)) !== undefined;
		const hasAnySourceEditor = _.any(editors.map(e => this.allSourceUris.has(e.document.uri)));

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

		this.allSourceUris.add(uri);

		return editor;
	}

	private getAllSourceEditors(): TextEditor[] {
		// It would be great if we could just store text editors and use those everywhere instead
		// of URIs or documents, but the text editor objects are not stable. For example, switching
		// from one tab to another then back to the first tab will most likely create an entirely
		// new editor object, even though it's the same underlying document.
		return window.visibleTextEditors.filter(editor => this.allSourceUris.has(editor.document.uri));
	}
}

function getEditor(uri: Uri): TextEditor | undefined {
	return window.visibleTextEditors.find(editor => equalUri(editor.document.uri, uri));
}
