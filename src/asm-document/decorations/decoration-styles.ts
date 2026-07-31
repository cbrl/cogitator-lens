/**
 * Text editor decoration styles shared by every AsmDecorator instance.
 */

import {
	OverviewRulerLane,
	window,
	ThemeColor,
} from 'vscode';
import type { OptimizationRemarkCategory } from '../../types/index.js';

export const selectedLineDecoration = window.createTextEditorDecorationType({
	isWholeLine: true,
	backgroundColor: new ThemeColor('editor.findMatchHighlightBackground'),
	overviewRulerColor: new ThemeColor('editorOverviewRuler.findMatchForeground'),
});

export const selectedSourceRangeDecoration = window.createTextEditorDecorationType({
	backgroundColor: new ThemeColor('editor.wordHighlightStrongBackground'),
	borderColor: new ThemeColor('editor.wordHighlightStrongBorder'),
	borderStyle: 'solid',
	borderWidth: '1px',
	overviewRulerColor: new ThemeColor('editorOverviewRuler.wordHighlightStrongForeground'),
});

export const unusedLineDecoration = window.createTextEditorDecorationType({
	opacity: '0.5',
});

export const stateDecoration = window.createTextEditorDecorationType({
	after: { color: 'gray' },
});

function optimizationRemarkDecoration(category: OptimizationRemarkCategory) {
	const background = new ThemeColor(
		`coglens.optimizationRemarks.${category}Background`,
	);
	return window.createTextEditorDecorationType({
		after: {
			backgroundColor: background,
			margin: '0 0 0 1.5em',
		},
		overviewRulerColor: background,
		overviewRulerLane: OverviewRulerLane.Right,
	});
}

export const optimizationRemarkDecorations = {
	passed: optimizationRemarkDecoration('passed'),
	missed: optimizationRemarkDecoration('missed'),
	analysis: optimizationRemarkDecoration('analysis'),
} as const;
