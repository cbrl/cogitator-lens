import { Disposable, Uri, EventEmitter, TextDocumentContentProvider, Event, window, workspace } from 'vscode';
import { CompiledAssembly } from './compiled-assembly';
import { CompileManager } from '../compile-database';
import { replaceExtension } from '../utils';

export class AsmProvider implements TextDocumentContentProvider {
    public static scheme = 'assembly';

    private _documents = new Map<string, CompiledAssembly>();
    private _onDidChange = new EventEmitter<Uri>();
	private onCloseDisposable: Disposable;

	private compileManager: CompileManager;

	constructor(compileDb: CompileManager) {
		this.compileManager = compileDb;

		this.onCloseDisposable = workspace.onDidCloseTextDocument(document => {
			if (document.uri.scheme === AsmProvider.scheme) {
				const asmDoc = this._documents.get(document.uri.path);
				if (asmDoc) {
					asmDoc.dispose();
					this._documents.delete(document.uri.path);
				}
			}
		});
	}

    public provideTextDocumentContent(uri: Uri): string | Thenable<string> {
        const document = this.provideAssembly(uri);
        const txt = document.getContent();
		return txt;
    }

    public provideAssembly(uri: Uri): CompiledAssembly {
        let document = this._documents.get(uri.path);

        if (!document) {
            document = new CompiledAssembly(Uri.parse(uri.query), uri, this.compileManager, this._onDidChange);
            this._documents.set(uri.path, document);
        }

        return document;
    }

	public async updateDocumentIfExists(uri: Uri): Promise<void> {
		const document = this._documents.get(uri.path);
		if (document) {
			await document.update();
		}
	}

    // Signals a change of a virtual assembly document. Implements TextDocumentContentProvider.onDidChange
    public get onDidChange(): Event<Uri> {
        return this._onDidChange.event;
    }

    public dispose(): void {
        this._documents.clear();
        this._onDidChange.dispose();
        this.onCloseDisposable.dispose();
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
