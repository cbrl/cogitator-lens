/**
 * Manages text editor decoration styles
 */

import { window, TextEditorDecorationType, ThemeColor } from 'vscode';

export class DecorationStyleManager {
	public readonly selectedLineDecoration: TextEditorDecorationType;
	public readonly unusedLineDecoration: TextEditorDecorationType;
	public readonly stateDecoration: TextEditorDecorationType;

	constructor() {
		this.selectedLineDecoration = window.createTextEditorDecorationType({
			isWholeLine: true,
			backgroundColor: new ThemeColor('editor.findMatchHighlightBackground'),
			overviewRulerColor: new ThemeColor('editorOverviewRuler.findMatchForeground')
		});

		this.unusedLineDecoration = window.createTextEditorDecorationType({
			opacity: '0.5'
		});

		this.stateDecoration = window.createTextEditorDecorationType({
			after: {
				color: 'gray'
			}
		});
	}

	public dispose(): void {
		this.selectedLineDecoration.dispose();
		this.unusedLineDecoration.dispose();
		this.stateDecoration.dispose();
	}
}
