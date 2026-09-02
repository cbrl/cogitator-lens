/**
 * Text editor decoration styles shared by every ArtifactDecorator instance.
 */

import { OverviewRulerLane, Uri, window, ThemeColor } from 'vscode';
import type { ArtifactLineAnnotationStyle, OptimizationRemarkCategory } from '../../types/index.js';

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

function jumpArrowIcon(path: string, forward: boolean): Uri {
	const light = forward ? '#286f9e' : '#a34f00';
	const dark = forward ? '#9cdcfe' : '#ffb454';
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><style>path{fill:none;stroke:${light};stroke-width:1.75;stroke-linecap:round;stroke-linejoin:round}@media(prefers-color-scheme:dark){path{stroke:${dark}}}@media(forced-colors:active){path{stroke:CanvasText}}</style><path d="${path}"/></svg>`;
	return Uri.parse(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
}

const forwardJumpSourceIcon = jumpArrowIcon('M14 8H10C7 8 5 10 5 13V15M2 12l3 3 3-3', true);
const forwardJumpTargetIcon = jumpArrowIcon('M5 1v3c0 3 2 4 5 4h5m-3-3 3 3-3 3', true);
const backwardJumpSourceIcon = jumpArrowIcon('M14 8H10C7 8 5 6 5 3V1M2 4l3-3 3 3', false);
const backwardJumpTargetIcon = jumpArrowIcon('M5 15v-3c0-3 2-4 5-4h5m-3-3 3 3-3 3', false);

function gutterDecoration(icon: Uri) {
	return window.createTextEditorDecorationType({
		gutterIconPath: icon,
		gutterIconSize: 'contain',
	});
}

export const jumpArrowDecorations = {
	forward: {
		source: gutterDecoration(forwardJumpSourceIcon),
		target: gutterDecoration(forwardJumpTargetIcon),
	},
	backward: {
		source: gutterDecoration(backwardJumpSourceIcon),
		target: gutterDecoration(backwardJumpTargetIcon),
	},
} as const;

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
		}),
	);
});

function optimizationRemarkDecoration(category: OptimizationRemarkCategory) {
	const background = new ThemeColor(`coglens.optimizationRemarks.${category}Background`);
	return window.createTextEditorDecorationType({
		after: {
			backgroundColor: background,
			margin: '0 0 0 1.5em',
		},
		overviewRulerColor: background,
		overviewRulerLane: OverviewRulerLane.Right,
	});
}

const stackUsageBackground = new ThemeColor('coglens.stackUsage.background');

const stackUsageDecoration = window.createTextEditorDecorationType({
	after: {
		backgroundColor: stackUsageBackground,
		margin: '0 0 0 1.5em',
	},
	overviewRulerColor: stackUsageBackground,
	overviewRulerLane: OverviewRulerLane.Right,
});

/** Total mapping from renderer-selected annotation styles to editor decorations. */
export const annotationStyleDecorations = {
	'optimization-passed': optimizationRemarkDecoration('passed'),
	'optimization-missed': optimizationRemarkDecoration('missed'),
	'optimization-analysis': optimizationRemarkDecoration('analysis'),
	'stack-usage': stackUsageDecoration,
} as const satisfies Record<ArtifactLineAnnotationStyle, ReturnType<typeof window.createTextEditorDecorationType>>;
