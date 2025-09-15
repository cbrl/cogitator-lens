import { CancellationToken, Disposable, Uri, EventEmitter, TextDocumentContentProvider, Event, ProviderResult, window, workspace, TextDocument, TabInputText, TabChangeEvent } from 'vscode';
import { CompileHandler } from './compile-handler';
import { CompileManager } from '../compile-database';
import { replaceExtension } from '../utils';
import { AsmDecorator } from './asm-decorator';
import { UriMap } from '../uri-containers';

export class AsmProvider implements TextDocumentContentProvider {
    public static scheme = 'assembly';

    private compileHandlers = new UriMap<CompileHandler>();
	private fileWatchers = new UriMap<Disposable>();
	private decorators = new UriMap<AsmDecorator>();

	private compileManager: CompileManager;

    private onDidChangeEvent = new EventEmitter<Uri>();

	private disposables: Disposable[] = [];

	constructor(compileDb: CompileManager) {
		this.compileManager = compileDb;

		const onCloseDisposable = workspace.onDidCloseTextDocument(this.onCloseTextDocument.bind(this));
		const onChangeTabsDisposable = window.tabGroups.onDidChangeTabs(this.onChangeTabs.bind(this));

		this.disposables.push(
			onCloseDisposable,
			onChangeTabsDisposable,
			this.onDidChangeEvent
		);
	}

	// Implements TextDocumentContentProvider.provideTextDocumentContent. This function will be called for the given
	// Uri when onDidChange(Uri) is fired. onDidChange will be fired when a source document changes and is recompiled
	// (or fails to recompile).
    public provideTextDocumentContent(uri: Uri, token: CancellationToken): ProviderResult<string> {
        const handler = this.getCompileHandler(uri);

		// If creating a TextEditor for the document, then also create a decorator for the editor.
		if (!this.decorators.has(handler.srcUri)) {
			const decorator = new AsmDecorator(handler.srcUri, handler.asmUri, handler.onDidChange);
			this.decorators.set(handler.srcUri, decorator);
		}

		return handler.update().then((result) => {
			return result.getContent();
		}).catch((error: Error) => {
			return error.message;
		});
    }

    private getCompileHandler(asmUri: Uri): CompileHandler {
        let document = this.compileHandlers.get(asmUri);

        if (!document) {
			const srcUri = Uri.parse(asmUri.query);

            document = new CompileHandler(srcUri, asmUri, this.compileManager);

			// Fire a change event for the ASM document when the source file changes.
			const watcher = workspace.createFileSystemWatcher(srcUri.fsPath);
			const disposable = watcher.onDidChange(() => this.onDidChangeEvent.fire(asmUri));
			this.fileWatchers.set(asmUri, Disposable.from(watcher, disposable));

            this.compileHandlers.set(asmUri, document);
        }

        return document;
    }

    // Signals a change of a virtual assembly document. Implements TextDocumentContentProvider.onDidChange
    public get onDidChange(): Event<Uri> {
        return this.onDidChangeEvent.event;
    }

    public dispose(): void {
		this.disposables.forEach(d => d.dispose());
		this.fileWatchers.forEach(d => d.dispose());
        this.compileHandlers.clear();
    }

	private onCloseTextDocument(document: TextDocument): void {
		const asmDoc = this.compileHandlers.get(document.uri);

		if (asmDoc) {
			this.unregisterDocument(document.uri);
		}
	}

	private onChangeTabs(event: TabChangeEvent): void {
		for (let tab of event.closed) {
			if (!(tab.input instanceof TabInputText)) {
				continue;
			}

			this.unregisterDocument(tab.input.uri);
		}
	}

	private unregisterDocument(uri: Uri): void {
		const asmDoc = this.compileHandlers.get(uri);
		const decorator = this.decorators.get(uri);
		const fileWatcher = this.fileWatchers.get(uri);

		if (asmDoc !== undefined) {
			asmDoc.dispose();
			this.compileHandlers.delete(uri);
		}

		if (decorator !== undefined) {
			decorator.dispose();
			this.decorators.delete(uri);
		}

		if (fileWatcher !== undefined) {
			fileWatcher.dispose();
			this.fileWatchers.delete(uri);
		}
	}
}

/**
 * Returns the source URI with a '.asm' extension. The original URI's file path is stored in the query field.
 */
export function getAsmUri(source: Uri): Uri {
    return source.with({
        scheme: AsmProvider.scheme,
		path: replaceExtension(source.path, '.asm'),
        query: source.toString() //query field stores original URI
    });
}
