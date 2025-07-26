import { CancellationToken, Disposable, Uri, EventEmitter, TextDocumentContentProvider, Event, ProviderResult, window, workspace, TextDocument, TabInputText, TabChangeEvent } from 'vscode';
import { CompiledAssembly } from './compiled-assembly';
import { CompileManager } from '../compile-database';
import { replaceExtension } from '../utils';
import { AsmDecorator } from './asm-decorator';
import { UriMap } from '../uri-containers';

export class AsmProvider implements TextDocumentContentProvider {
    public static scheme = 'assembly';

    private documents = new UriMap<CompiledAssembly>();
	private decorators = new UriMap<AsmDecorator>();

	private compileManager: CompileManager;

    private onDidChangeEvent = new EventEmitter<Uri>();

	private disposables: Disposable;

	constructor(compileDb: CompileManager) {
		this.compileManager = compileDb;

		const onCloseDisposable = workspace.onDidCloseTextDocument(this.onCloseTextDocument.bind(this));

		const onChangeTabsDisposable = window.tabGroups.onDidChangeTabs(this.onChangeTabs.bind(this));

		this.disposables = Disposable.from(
			onCloseDisposable,
			onChangeTabsDisposable,
			this.onDidChangeEvent
		);
	}

    public provideTextDocumentContent(uri: Uri, token: CancellationToken): ProviderResult<string> {
        const document = this.provideAssembly(uri);

		// If creating a TextEditor for the document, then also create a decorator for the editor.
		if (!this.decorators.has(document.srcUri)) {
			this.decorators.set(document.srcUri, new AsmDecorator(document));
		}

		const txt = document.getContent();
		return txt;
    }

    public provideAssembly(uri: Uri): CompiledAssembly {
        let document = this.documents.get(uri);

        if (!document) {
            document = new CompiledAssembly(Uri.parse(uri.query), uri, this.compileManager, this.onDidChangeEvent);
            this.documents.set(uri, document);
        }

        return document;
    }

	public async updateDocumentIfExists(uri: Uri): Promise<void> {
		const document = this.documents.get(uri);
		if (document) {
			await document.update();
		}
	}

    // Signals a change of a virtual assembly document. Implements TextDocumentContentProvider.onDidChange
    public get onDidChange(): Event<Uri> {
        return this.onDidChangeEvent.event;
    }

    public dispose(): void {
        this.documents.clear();
        this.disposables.dispose();
    }

	private onCloseTextDocument(document: TextDocument): void {
		const asmDoc = this.documents.get(document.uri);

		if (asmDoc) {
			asmDoc.dispose();
			this.documents.delete(document.uri);
		}
	}

	private onChangeTabs(event: TabChangeEvent): void {
		for (let tab of event.closed) {
			if (!(tab.input instanceof TabInputText)) {
				continue;
			}

			const asmDoc = this.documents.get(tab.input.uri);
			const decorator = this.decorators.get(tab.input.uri);

			if (asmDoc) {
				asmDoc.dispose();
				this.documents.delete(tab.input.uri);
			}

			if (decorator) {
				decorator.dispose();
				this.decorators.delete(tab.input.uri);
			}
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
