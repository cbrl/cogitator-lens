/**
 * Tracks and manages editors for source and assembly files
 */

import { TextEditor, window, Uri, TextDocumentShowOptions } from 'vscode';
import { UriSet } from '../../uri-containers.js';
import { equalUri, toComparisonKey } from '../../utils.js';

export class EditorTracker {
	private pendingEditors = new Map<string, Promise<TextEditor>>();

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
		const key = toComparisonKey(uri);
		const pending = this.pendingEditors.get(key);
		if (pending) {
			return pending;
		}

		const promise = Promise.resolve(window.showTextDocument(uri, options)).then(editor => {
			this.pendingEditors.delete(key);
			return editor;
		}, err => {
			this.pendingEditors.delete(key);
			throw err;
		});

		this.pendingEditors.set(key, promise);
		return promise;
	}

	/**
	 * Check if an editor is for a source file
	 */
	isSourceEditor(editor: TextEditor, srcUris: UriSet): boolean {
		return srcUris.has(editor.document.uri);
	}

	/**
	 * Check if an editor is for the assembly file
	 */
	isAsmEditor(editor: TextEditor, asmUri: Uri): boolean {
		return equalUri(editor.document.uri, asmUri);
	}
}
