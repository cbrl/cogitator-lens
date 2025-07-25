import { workspace, Uri, Event, EventEmitter, FileSystemWatcher, window } from 'vscode';
import { ParsedAsmResultLine } from '../parsers/asmresult.interfaces';
import { CompileManager } from '../compile-database';
import * as logger from '../logger';

export class CompiledAssembly {
    private _srcUri: Uri;
	private _asmUri: Uri;
    private _providerEmitter: EventEmitter<Uri>;
	private _selfEmitter: EventEmitter<void> = new EventEmitter<void>();
    private _watcher: FileSystemWatcher;

	private compileManager: CompileManager;

	public lines: ParsedAsmResultLine[] = [];
	public sourceToAsmMapping = new Map<number, number[]>();

    constructor(srcUri: Uri, asmUri: Uri, compileManager: CompileManager, providerEmitter: EventEmitter<Uri>) {
        this._srcUri = srcUri;
		this._asmUri = asmUri;
		this.compileManager = compileManager;

        // The AsmDocument signals changes through the event emitter from the containing provider
        this._providerEmitter = providerEmitter;

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
			window.showErrorMessage(`Compile failed. Verify buildsystem settings and/or wait for configuration to complete. See log for error details.`);
			logger.logChannel.error(errorMessage);
		}

		// Causes VSCode to call TextDocumentContentProvider.provideTextDocumentContent() again
		this._providerEmitter.fire(this._asmUri);

		this._selfEmitter.fire();
    }

    public getContent(): string {
		return this.lines.map(line => line.text).join('\n');
    }

	/**
	 * Fired when the assembly document is updated (i.e. after compilation). {@link AsmProvider.onDidChange}
	 * will fire at the same time as well, but this event is specific to this instance.
	 */
	public get onDidChange(): Event<void> {
		return this._selfEmitter.event;
	}

    public dispose(): void {
        this._watcher.dispose();
    }
}
