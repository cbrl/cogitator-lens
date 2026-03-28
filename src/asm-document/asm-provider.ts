import { CancellationToken, Disposable, Uri, EventEmitter, TextDocumentContentProvider, Event, ProviderResult, window, workspace, TextDocument, TabInputText } from 'vscode';
import { CompileHandler } from './compile-handler';
import { CompilationService } from '../compilation/index.js';
import { CompiledAssembly } from './compiled-assembly';
import { replaceExtension } from '../utils';
import { AsmDecorator } from './asm-decorator';
import { DecorationStyleManager } from './decorations/decoration-style-manager';
import { UriMap } from '../uri-containers';

export class AsmProvider implements TextDocumentContentProvider {
    public static scheme = 'assembly';

    private compileHandlers = new UriMap<CompileHandler>();
	private fileWatchers = new UriMap<Disposable>();
	private decorators = new UriMap<AsmDecorator>();
	private compiledAssemblies = new UriMap<CompiledAssembly>();
	private readonly styleManager = new DecorationStyleManager();

	private compileManager: CompilationService;

    private onDidChangeEvent = new EventEmitter<Uri>();

	private disposables: Disposable[] = [];

	constructor(compileDb: CompilationService) {
		this.compileManager = compileDb;

		const onCloseDisposable = workspace.onDidCloseTextDocument(this.onCloseTextDocument.bind(this));

		this.disposables.push(
			onCloseDisposable,
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
			const decorator = new AsmDecorator(handler.srcUri, handler.asmUri, handler.onDidChange, this.styleManager);
			this.decorators.set(handler.srcUri, decorator);
		}

		return handler.update().then((result) => {
			this.compiledAssemblies.set(uri, result);
			return result.getContent();
		}).catch((error: Error) => {
			this.compiledAssemblies.delete(uri);
			return error.message;
		});
    }

    private getCompileHandler(asmUri: Uri): CompileHandler {
        let document = this.compileHandlers.get(asmUri);

        if (!document) {
			const srcUri = Uri.parse(asmUri.query);

            document = new CompileHandler(srcUri, asmUri, this.compileManager);

			// Track the latest compiled assembly for definition provider lookups
			const compileEventDisposable = document.onDidChange((resultOrError) => {
				if (resultOrError instanceof CompiledAssembly) {
					this.compiledAssemblies.set(asmUri, resultOrError);
				} else {
					this.compiledAssemblies.delete(asmUri);
				}
			});

			// Fire a change event for the ASM document when the source file changes.
			const watcher = workspace.createFileSystemWatcher(srcUri.fsPath);
			const disposable = watcher.onDidChange(() => this.onDidChangeEvent.fire(asmUri));
			this.fileWatchers.set(asmUri, Disposable.from(watcher, disposable, compileEventDisposable));

            this.compileHandlers.set(asmUri, document);
        }

        return document;
    }

    // Signals a change of a virtual assembly document. Implements TextDocumentContentProvider.onDidChange
    public get onDidChange(): Event<Uri> {
        return this.onDidChangeEvent.event;
    }

	public getCompiledAssembly(uri: Uri): CompiledAssembly | undefined {
		return this.compiledAssemblies.get(uri);
	}

    public dispose(): void {
		this.disposables.forEach(d => d.dispose());
		this.fileWatchers.forEach(d => d.dispose());
		this.decorators.forEach(d => d.dispose());
		this.styleManager.dispose();
        this.compileHandlers.clear();
    }

	private onCloseTextDocument(document: TextDocument): void {
		if (!this.compileHandlers.has(document.uri)) {
			return;
		}

		// Guard against race condition: if the user reopens the same assembly document quickly,
		// the delayed close event from the old document would destroy the new handler/decorator.
		// Only clean up if no tab still shows this document.
		const hasOpenTab = window.tabGroups.all.some(group =>
			group.tabs.some(tab =>
				tab.input instanceof TabInputText && tab.input.uri.toString() === document.uri.toString()
			)
		);

		if (!hasOpenTab) {
			this.unregisterDocument(document.uri);
		}
	}

	private unregisterDocument(uri: Uri): void {
		const handler = this.compileHandlers.get(uri);

		if (handler !== undefined) {
			// Decorators are keyed by srcUri, not asmUri
			const decorator = this.decorators.get(handler.srcUri);
			if (decorator !== undefined) {
				decorator.dispose();
				this.decorators.delete(handler.srcUri);
			}

			handler.dispose();
			this.compileHandlers.delete(uri);
		}

		const fileWatcher = this.fileWatchers.get(uri);
		if (fileWatcher !== undefined) {
			fileWatcher.dispose();
			this.fileWatchers.delete(uri);
		}

		this.compiledAssemblies.delete(uri);
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
