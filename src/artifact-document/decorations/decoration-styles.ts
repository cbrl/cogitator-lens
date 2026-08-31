/**
 * Text editor decoration styles shared by every ArtifactDecorator instance.
 */

import {
	OverviewRulerLane,
	window,
	ThemeColor,
} from 'vscode';
import type { OptimizationRemarkCategory } from '../../types/index.js';

export const selectedLineDecoration = window.createTextEditorDecorationType({
	isWholeLine: true,
	backgroundColor: new ThemeColor('coglens.selection.background'),
	overviewRulerColor: new ThemeColor('coglens.selection.overviewRuler'),
});

export const selectedSourceRangeDecoration = window.createTextEditorDecorationType({
	backgroundColor: new ThemeColor('coglens.sourceRange.background'),
	borderColor: new ThemeColor('coglens.sourceRange.border'),
	borderStyle: 'solid',
	borderWidth: '1px',
	overviewRulerColor: new ThemeColor('coglens.sourceRange.overviewRuler'),
});

export const unusedLineDecoration = window.createTextEditorDecorationType({
	opacity: '0.5',
});

export const stateDecoration = window.createTextEditorDecorationType({
	after: { color: new ThemeColor('coglens.state.foreground') },
});

export const binaryColumnsDecoration = window.createTextEditorDecorationType({
	before: {
		color: new ThemeColor('coglens.binaryColumns.foreground'),
		backgroundColor: new ThemeColor('coglens.binaryColumns.background'),
		fontStyle: 'normal',
		fontWeight: 'normal',
		margin: '0 1.5em 0 0',
	},
});

export const sourceLineBandDecorations = Array.from({ length: 6 }, (_, index) => {
	const background = new ThemeColor(`coglens.sourceLineBand.${index + 1}Background`);
	const marker = new ThemeColor(`coglens.sourceLineBand.${index + 1}Marker`);
	return window.createTextEditorDecorationType({
		isWholeLine: true,
		backgroundColor: background,
		borderColor: marker,
		borderStyle: 'solid',
		borderWidth: '0 0 0 2px',
		overviewRulerColor: marker,
		overviewRulerLane: OverviewRulerLane.Left,
	});
});

const densityLevelCount = 5;

/**
 * An opaque band at the source text edge. Color matches the corresponding
 * source-line mapping highlight; width encodes relative output density while
 * leaving the glyph margin free for breakpoints and diagnostics.
 */
export const sourceDensityDecorations = sourceLineBandDecorations.map((_, bandIndex) => {
	const color = new ThemeColor(`coglens.sourceLineBand.${bandIndex + 1}Marker`);
	return Array.from({ length: densityLevelCount }, (_, densityIndex) =>
		window.createTextEditorDecorationType({
			isWholeLine: true,
			borderColor: color,
			borderStyle: 'solid',
			borderWidth: `0 0 0 ${densityIndex + 1}px`,
			overviewRulerColor: color,
			overviewRulerLane: OverviewRulerLane.Center,
		}));
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

const stackUsageBackground = new ThemeColor('coglens.stackUsage.background');

export const stackUsageDecoration = window.createTextEditorDecorationType({
	after: {
		backgroundColor: stackUsageBackground,
		margin: '0 0 0 1.5em',
	},
	overviewRulerColor: stackUsageBackground,
	overviewRulerLane: OverviewRulerLane.Right,
});
