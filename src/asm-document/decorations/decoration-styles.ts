/**
 * Text editor decoration styles shared by every AsmDecorator instance.
 */

import { window, ThemeColor } from 'vscode';

export const selectedLineDecoration = window.createTextEditorDecorationType({
	isWholeLine: true,
	backgroundColor: new ThemeColor('editor.findMatchHighlightBackground'),
	overviewRulerColor: new ThemeColor('editorOverviewRuler.findMatchForeground'),
});

export const unusedLineDecoration = window.createTextEditorDecorationType({
	opacity: '0.5',
});

export const stateDecoration = window.createTextEditorDecorationType({
	after: { color: 'gray' },
});
