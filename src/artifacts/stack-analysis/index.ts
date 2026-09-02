import type { ArtifactDefinition } from '../core/artifact-contracts.js';
import { renderNativeStackAnalysis } from './native-stack-analysis.js';

export const stackAnalysisArtifact = {
	label: 'Stack analysis',
	options: [],
	presentation: 'text',
	icon: 'layers',
	filenameExtension: '.stack',
	documentLanguage: 'source',
	renderer: renderNativeStackAnalysis,
	navigation: {
		definitions: true,
		sourceLocations: true,
		links: false,
		folds: false,
		symbols: false,
	},
	metricLabels: {
		functionCount: 'Function count',
		largestFrame: 'Largest known frame',
		largestFrameUnit: 'Largest frame unit',
		totalKnownFrame: 'Total known frame',
		totalKnownFrameUnit: 'Total frame unit',
		dynamicFrameCount: 'Dynamic frame count',
		unmappedEntryCount: 'Unmapped entry count',
	},
} as const satisfies ArtifactDefinition;
