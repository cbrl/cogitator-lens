/**
 * Tracks and manages editors for source and assembly files
 */

import { TextEditor, window, Uri, TextDocumentShowOptions } from 'vscode';
import { sourceUriMap, UriSet } from '../../uri-containers.js';
import { equalUri } from '../../utils.js';

export class EditorTracker {
	private pendingEditors = sourceUriMap<Promise<TextEditor>>();

	/**
	 * Get all visible editors for the given source URIs
	 */
	getSourceEditors(srcUris: UriSet): TextEditor[] {
		return window.visibleTextEditors.filter(editor => srcUris.has(editor.document.uri));
	}

	/**
	 * Get the editor for the assembly URI
	 */
	getAsmEditor(asmUri: Uri): TextEditor | undefined {
		return window.visibleTextEditors.find(editor => equalUri(editor.document.uri, asmUri));
	}

	/**
	 * Get or create an editor for the given URI
	 */
	async getOrCreateSourceEditor(uri: Uri, options?: TextDocumentShowOptions): Promise<TextEditor> {
		// Check if the editor is already open
		const existingEditor = window.visibleTextEditors.find(editor => equalUri(editor.document.uri, uri));
		if (existingEditor) {
			return existingEditor;
		}

		// Deduplicate concurrent requests for the same URI
		const pending = this.pendingEditors.get(uri);
		if (pending) {
			return pending;
		}

		const promise = Promise.resolve(window.showTextDocument(uri, options)).then(editor => {
			this.pendingEditors.delete(uri);
			return editor;
		}, err => {
			this.pendingEditors.delete(uri);
			throw err;
		});

		this.pendingEditors.set(uri, promise);
		return promise;
	}
}
