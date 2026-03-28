import { TextEditor, window, Range, Event, Uri, Disposable, TextEditorRevealType, TextDocument, TextEditorSelectionChangeEvent } from 'vscode';
import { CompiledAssembly } from './compiled-assembly';
import { ParsedAsmResultLine } from '../parsers/asmresult.interfaces';
import path from 'path';
import { equalUri } from '../utils';
import assert from 'assert';
import { DecorationStyleManager } from './decorations/decoration-style-manager.js';
import { EditorTracker } from './decorations/editor-tracker.js';
import { ConfigurationService } from '../services/configuration-service.js';

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

    private asmData: CompiledAssembly | Error;

	private readonly styleManager: DecorationStyleManager;
	private readonly editorTracker: EditorTracker;
	private readonly configService: ConfigurationService;
    private readonly registrations: Disposable;

	private active: boolean = true;
	private isDisposed: boolean = false;

    constructor(srcUri: Uri, asmUri: Uri, asmEvent: Event<CompiledAssembly | Error>, styleManager: DecorationStyleManager) {
		this.asmUri = asmUri;
		this.srcUri = srcUri;
		this.asmData = new CompiledAssembly(this.srcUri, this.asmUri, []);

		// Initialize services
		this.styleManager = styleManager;
		this.editorTracker = new EditorTracker();
		this.configService = new ConfigurationService();

        this.refreshDecorations();

        // Rebuild mapping and decorations on asm document change
        const providerEventRegistration = asmEvent((resultOrError) => {
			this.asmData = resultOrError;
			this.refreshDecorations();
        });

		const visibilityChangeRegistration = window.onDidChangeVisibleTextEditors(this.onChangeVisibleEditors.bind(this));

		const selectionChangeRegistration = window.onDidChangeTextEditorSelection(this.onEditorSelectionChanged.bind(this));

        this.registrations = Disposable.from(
            providerEventRegistration,
			visibilityChangeRegistration,
            selectionChangeRegistration
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

		// Recalculate active state now that asmData may have changed
		this.updateActiveState();

		this.dimUnusedSourceLines();

		// Treat as if the user selected the current line of the first editor (only highlights the line, doesn't scroll)
		// TODO: use active editor instead of the first visible source editor?
		if (this.asmData.lines.length > 0) {
			this.onSrcLineSelected(this.getAllSourceEditors()[0], true);
		}

		// If the ASM document is empty, show a loading decoration.
		// TODO: detect compile state instead of just checking line count
		if (this.asmData.lines.length === 0) {
			const asmEditor = this.editorTracker.getAsmEditor(this.asmUri);
			asmEditor?.setDecorations(this.styleManager.loadingDecoration, [new Range(0, 0, 0, 0)]);
		}
	}

    private asmLineHasSource(asmLine: ParsedAsmResultLine) {
        // eslint-disable-next-line eqeqeq
        return (asmLine.source?.file != null && asmLine.source?.line != null); //checks null or undefined
    }

	private clearDecorations(editor: TextEditor) {
		editor.setDecorations(this.styleManager.selectedLineDecoration, []);
		editor.setDecorations(this.styleManager.unusedLineDecoration, []);
		editor.setDecorations(this.styleManager.loadingDecoration, []);
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
			const dimUnused = this.configService.getDimUnusedSourceLines(editor.document.uri);

			if (dimUnused) {
				editor.setDecorations(this.styleManager.unusedLineDecoration, getUnusedLines(editor.document));
			}
		}
    }

    private onSrcLineSelected(selectedEditor: TextEditor, highlightOnly: boolean = false): void {
		if (this.asmData instanceof Error) {
			return;
		}

		const asmEditor = this.editorTracker.getAsmEditor(this.asmUri);

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
        selectedEditor.setDecorations(this.styleManager.selectedLineDecoration, [srcLineRange]);

		// Highlight associated lines in ASM editor
		const asmLines: Range[] = getSelectedLines(selectedEditor.document.uri, selectedEditor.selection.start.line);

		for (let editor of this.getAllSourceEditors()) {
			if (editor !== selectedEditor) {
				asmLines.push(...getSelectedLines(editor.document.uri, editor.selection.start.line));
			}
		}

        asmEditor.setDecorations(this.styleManager.selectedLineDecoration, asmLines);

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
        asmEditor.setDecorations(this.styleManager.selectedLineDecoration, [asmLineRange]);

		// Highlight associated lines in source editor
        if (this.asmLineHasSource(asmLine)) {
			const srcUri = Uri.file(path.normalize(asmLine.source!.file!));

			// Open the correct source document if this line of assembly refers to a different file
			this.getOrCreateSourceEditor(srcUri).then(targetEditor => {
				if (this.isDisposed) {
					return;
				}

				const srcLineIndex = asmLine.source!.line! - 1;
				if (srcLineIndex < 0 || srcLineIndex >= targetEditor.document.lineCount) {
					return;
				}

				const srcLineRange = targetEditor.document.lineAt(srcLineIndex).range;

				targetEditor.setDecorations(this.styleManager.selectedLineDecoration, [srcLineRange]);

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
				editor.setDecorations(this.styleManager.selectedLineDecoration, []);
			}
        }
    }

	private updateActiveState(): void {
		if (this.asmData instanceof Error) {
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

	private onChangeVisibleEditors(): void {
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
		if (this.asmData instanceof Error) {
			return [];
		}

		return this.editorTracker.getSourceEditors(this.asmData.allReferencedSrcUris);
	}
}
