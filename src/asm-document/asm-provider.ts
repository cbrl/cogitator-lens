import { Uri, EventEmitter, TextDocumentContentProvider, Event, window } from 'vscode';
import { AsmDocument } from './asm-document';
import { CompileManager } from '../compile-database';
import { replaceExtension } from '../utils';

export class AsmProvider implements TextDocumentContentProvider {
    static scheme = 'assembly';

    private _documents = new Map<string, AsmDocument>();
    private _onDidChange = new EventEmitter<Uri>();

	private compileManager: CompileManager;

	constructor(compileDb: CompileManager) {
		this.compileManager = compileDb;
	}

    public provideTextDocumentContent(uri: Uri): string | Thenable<string> {
        const document = this.provideAsmDocument(uri);
        const txt = document.getContent();
		return txt;
    }

    public provideAsmDocument(uri: Uri): AsmDocument {
        let document = this._documents.get(uri.path);

        if (!document) {
            document = new AsmDocument(Uri.parse(uri.query), uri, this.compileManager, this._onDidChange);
            this._documents.set(uri.path, document);
        }

        return document;
    }

	public async updateAsmDocument(uri: Uri): Promise<void> {
		return this._documents.get(uri.path)?.update();
	}

    // Signals a change of a virtual AsmDocument
    public get onDidChange(): Event<Uri> {
        return this._onDidChange.event;
    }

    public dispose(): void {
        this._documents.clear();
        this._onDidChange.dispose();
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
