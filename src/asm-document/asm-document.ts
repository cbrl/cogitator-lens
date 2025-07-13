import { workspace, Uri, EventEmitter, FileSystemWatcher, window } from 'vscode';
import { ParsedAsmResultLine } from '../parsers/asmresult.interfaces';
import { CompileManager } from '../compile-database';

export class AsmDocument {
    private _srcUri: Uri;
	private _asmUri: Uri;
    private _emitter: EventEmitter<Uri>;
    private _watcher: FileSystemWatcher;

	private compileManager: CompileManager;

	public lines: ParsedAsmResultLine[] = [];
	public sourceToAsmMapping = new Map<number, number[]>();

    constructor(srcUri: Uri, asmUri: Uri, compileManager: CompileManager, emitter: EventEmitter<Uri>) {
        this._srcUri = srcUri;
		this._asmUri = asmUri;
		this.compileManager = compileManager;

        // The AsmDocument signals changes through the event emitter from the containing provider
        this._emitter = emitter;

        // Watch for underlying assembly file and reload it on change
        this._watcher = workspace.createFileSystemWatcher(this._srcUri.fsPath);
        this._watcher.onDidChange(() => this.updateLater());
        this._watcher.onDidCreate(() => this.updateLater());
        this._watcher.onDidDelete(() => this.updateLater());

        this.update();
    }

    private updateLater(): void {
        // https://github.com/Microsoft/vscode/issues/72831
        setTimeout(() => this.update(), 100);
    }

    public async update(): Promise<void> {
		try {
			const compileResult = await this.compileManager.compile(this._srcUri);
			this.lines = compileResult.asm;
		}
		catch (error) {
			const errorMessage = (error instanceof Error) ? error.message : JSON.stringify(error);
			window.showErrorMessage(`Failed to compile (${errorMessage}). Verify buildsystem settings and/or wait for configuration to complete.`);
		}

		// Causes VSCode to call TextDocumentContentProvider.provideTextDocumentContent() again
		this._emitter.fire(this._asmUri);
    }

    public getContent(): string {
		return this.lines.map(line => line.text).join('\n');
    }

    public dispose(): void {
        this._watcher.dispose();
    }
}
