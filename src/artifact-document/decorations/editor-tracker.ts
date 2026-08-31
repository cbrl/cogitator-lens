/**
 * Tracks and manages editors for source and assembly files
 */

import { TextEditor, window, Uri } from 'vscode';
import { UriSet } from '../../uri-containers.js';
import { equalUri } from '../../utils.js';

export class EditorTracker {
	/**
	 * Get all visible editors for the given source URIs
	 */
	getSourceEditors(sourceUris: UriSet): TextEditor[] {
		return window.visibleTextEditors.filter((editor) => sourceUris.has(editor.document.uri));
	}

	/**
	 * Get the editor for the assembly URI
	 */
	getArtifactEditor(artifactUri: Uri): TextEditor | undefined {
		return window.visibleTextEditors.find((editor) => equalUri(editor.document.uri, artifactUri));
	}
}
