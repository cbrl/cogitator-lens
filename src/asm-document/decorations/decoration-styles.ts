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
		isWholeLine: true,
		backgroundColor: background,
		overviewRulerColor: background,
		overviewRulerLane: OverviewRulerLane.Right,
	});
}

export const optimizationRemarkDecorations = {
	passed: optimizationRemarkDecoration('passed'),
	missed: optimizationRemarkDecoration('missed'),
	analysis: optimizationRemarkDecoration('analysis'),
} as const;
