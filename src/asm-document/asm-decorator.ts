import { TextEditor, window, TextEditorDecorationType, Range, ThemeColor, workspace, Uri, Disposable, TextEditorRevealType, TextDocument, ViewColumn, TextEditorSelectionChangeKind, TextEditorSelectionChangeEvent } from 'vscode';
import { AsmProvider } from './asm-provider';
import { CompiledAssembly } from './compiled-assembly';
import { ParsedAsmResultLine } from '../parsers/asmresult.interfaces';
import _ from 'underscore';
import path from 'path';

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
    private srcDocument: TextDocument; //primary source document that was compiled to ASM
	private secondarySourceDocuments: TextDocument[] = []; //secondary documents that were included in the compiled ASM
    private asmDocument: TextDocument;

	private visibleSrcEditors: TextEditor[] = [];
	private asmEditor: TextEditor;

    private asmData: CompiledAssembly;

    private selectedLineDecorationType: TextEditorDecorationType;
    private unusedLineDecorationType: TextEditorDecorationType;
	private loadingDecorationType: TextEditorDecorationType;
    private registrations: Disposable;

	private active: boolean = true;

    // Mapping of source line to assembly line for each source file: file -> (source line -> ASM line)
    private mappings = new Map<string, Map<number, number[]>>();

    constructor(srcEditor: TextEditor, asmEditor: TextEditor, asmData: CompiledAssembly) {
        this.srcDocument = srcEditor.document;
        this.asmDocument = asmEditor.document;
		this.visibleSrcEditors.push(srcEditor);
        this.asmEditor = asmEditor;
        this.asmData = asmData;

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
        this.applyDecorations();

        // Rebuild mapping and decorations on asm document change
        const providerEventRegistration = asmData.onDidChange(() => {
            this.loadMappings();
			this.applyDecorations();
        });

		const visibilityChangeRegistration = window.onDidChangeVisibleTextEditors(this.onChangeVisibleEditors.bind(this));

		const selectionChangeRegistration = window.onDidChangeTextEditorSelection(this.onEditorSelectionChanged.bind(this));

		const documentCloseRegistration = workspace.onDidCloseTextDocument(document => {
			// Dispose of decorator if ASM window was closed
			if (document === asmEditor.document) {
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

    public async onEditorSelectionChanged(event: TextEditorSelectionChangeEvent): Promise<void> {
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

		if (this.visibleSrcEditors.includes(event.textEditor)) {
			this.onSrcLineSelected(event.textEditor);
		}
		else if (event.textEditor === this.asmEditor) {
			await this.onAsmLineSelected();
		}
    }

    private applyDecorations() {
		this.clearAllDecorations();

        const dimUnused = workspace.getConfiguration('', this.srcDocument.uri)
            .get('coglens.dimUnusedSourceLines', true);

        if (dimUnused) {
            this.dimUnusedSourceLines();
        }

		this.onAsmLineSelected();

		for (let editor of this.visibleSrcEditors) {
			this.onSrcLineSelected(editor);
		}

		if (this.asmData.lines.length === 0) {
			// If the ASM document is empty, show a loading decoration
			this.asmEditor.setDecorations(this.loadingDecorationType, [new Range(0, 0, 0, 0)]);
		}
	}

    private loadMappings() {
        this.mappings.clear();

        this.asmData.lines.forEach((line, index) => {
            if (!this.asmLineHasSource(line)) {
                return;
            }
			const sourceFile = Uri.file(path.normalize(line.source!.file!)).fsPath;
            const sourceLine = line.source!.line! - 1;

			let lineMap = this.mappings.get(sourceFile);
			if (lineMap === undefined) {
				lineMap = new Map();
				this.mappings.set(sourceFile, lineMap);
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
		for (let editor of this.visibleSrcEditors) {
			this.clearDecorations(editor);
		}

		this.clearDecorations(this.asmEditor);
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

		for (let editor of this.visibleSrcEditors) {
			editor.setDecorations(this.unusedLineDecorationType, getUnusedLines(editor.document));
		}
    }

    private onSrcLineSelected(selectedEditor: TextEditor) {
		const getSelectedLines = (srcFile: string, line: number) => {
			const asmLinesRanges: Range[] = [];
			const mapped = this.mappings.get(srcFile)?.get(line);

			if (mapped !== undefined) {
				for (let line of mapped) {
					if (line >= this.asmDocument.lineCount) {
						continue;
					}
					asmLinesRanges.push(this.asmDocument.lineAt(line).range);
				};
			}

			return asmLinesRanges;
		};

		// Highlight selected line in source editor
        const srcLineRange = selectedEditor.document.lineAt(selectedEditor.selection.start.line).range;
        selectedEditor.setDecorations(this.selectedLineDecorationType, [srcLineRange]);

		// Highlight associated lines in ASM editor
		const asmLines: Range[] = getSelectedLines(selectedEditor.document.uri.fsPath, selectedEditor.selection.start.line);

		for (let editor of this.visibleSrcEditors) {
			if (editor !== selectedEditor) {
				asmLines.push(...getSelectedLines(editor.document.uri.fsPath, editor.selection.start.line));
			}
		}

        this.asmEditor.setDecorations(this.selectedLineDecorationType, asmLines);

        if (asmLines.length > 0) {
			// First line will be from the editor that actually had its selection changed (the editor passed to this function)
            this.asmEditor.revealRange(asmLines[0], TextEditorRevealType.InCenterIfOutsideViewport);
        }
    }

    private async onAsmLineSelected() {
		const line = this.asmEditor.selection.start.line;
        const asmLine = this.asmData.lines[line];

		// Highlight selected line in ASM editor
        const asmLineRange = this.asmEditor.document.lineAt(line).range;
        this.asmEditor.setDecorations(this.selectedLineDecorationType, [asmLineRange]);

		// Highlight associated lines in source editor
        if (this.asmLineHasSource(asmLine)) {
			const srcUri = Uri.file(path.normalize(asmLine.source!.file!));

			// Open the correct source document if this line of assembly refers to a different file
			const targetEditor = await this.getOrCreateSecondarySourceEditor(srcUri);

            const srcLineRange = targetEditor.document.lineAt(asmLine.source!.line! - 1).range;
            targetEditor.setDecorations(this.selectedLineDecorationType, [srcLineRange]);
            targetEditor.revealRange(srcLineRange, TextEditorRevealType.InCenterIfOutsideViewport);
        }
		else {
			// Clear selected line decoration when the assembly editor line doesn't correspond to a source location
			for (let editor of this.visibleSrcEditors) {
				editor.setDecorations(this.selectedLineDecorationType, []);
			}
        }
    }

	private onChangeVisibleEditors(editors: readonly TextEditor[]): void {
		const previouslyVisibleSrcEditors = this.visibleSrcEditors;

		// Editors can seemingly change under us. When switching from an editor to a different tab, then back
		// to the editor, this.[x]Editor will no longer refer to any editor inside the new array of visible
		// editors. Comparing the documents seems to always work though. However, if the user had multiple editors
		// for the same document, this might not find the editor that the ASM view was originally opened on. It
		// might be better to find all editors that match the document to handle this case.
		this.asmEditor = editors.find(editor => editor.document === this.asmDocument) ?? this.asmEditor;
		this.visibleSrcEditors = editors.filter(editor => editor.document === this.srcDocument || this.mappings.has(editor.document.uri.fsPath));

		// Active if the assembly editor is visible and one of the associated source editors is visible
		this.active = editors.includes(this.asmEditor) && _.any(editors.map(e => this.mappings.has(e.document.uri.fsPath)));

		// Clear any source editors that are no longer visible
		previouslyVisibleSrcEditors.filter(editor => !this.visibleSrcEditors.includes(editor)).forEach(editor => this.clearDecorations(editor));

		if (this.active) {
			this.onAsmLineSelected();
			this.visibleSrcEditors.forEach(editor => this.onSrcLineSelected(editor));

			// Update decorations when the editors change
			const dimUnused = workspace.getConfiguration('', this.srcDocument.uri).get('coglens.dimUnusedSourceLines', true);

			if (dimUnused) {
				this.dimUnusedSourceLines();
			}
		}
		else {
			// Clear all decorations if no longer active. An editor that goes out of view will automatically have
			// its decorations cleared, but the corresponding source/assembly editor won't if it's still visible.
			this.clearAllDecorations();
		}
	}

	// Get the editor for a source document that is referenced by the current ASM document (but isn't the main source
	// document that was compiled to ASM)
	private async getOrCreateSecondarySourceEditor(uri: Uri): Promise<TextEditor> {
		// Doesn't do anything if the document was already opened
		const document = await workspace.openTextDocument(uri);

		let editor = this.visibleSrcEditors.find(editor => editor.document === document);

		// Open an editor for the document if it isn't open or visible
		if (editor === undefined) {
			// Open on the same column as the first visible source editor, or on the first column if no editors are open.
			const column = (this.visibleSrcEditors.length > 0) ? this.visibleSrcEditors[0].viewColumn : ViewColumn.One;

			editor = await window.showTextDocument(document, {
				viewColumn: column,
				preserveFocus: true //don't put focus on the new editor
			});

			this.visibleSrcEditors.push(editor);
		}

		// Add to secondary documents list if not the primary source document and not already opened
		if (document !== this.srcDocument && !this.secondarySourceDocuments.includes(document)) {
			this.secondarySourceDocuments.push(document);
		}

		return editor;
	}
}
