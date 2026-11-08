import { displayOptionDescriptors, type ArtifactDefinition } from '../core/artifact-contracts.js';
import { renderOptimizationPipeline } from './pipeline-renderer.js';

export const optimizationPipelineArtifact = {
	label: 'Optimization pipeline',
	options: [displayOptionDescriptors.showUnchangedPasses],
	presentation: 'text',
	requiresFunctionFilter: true,
	icon: 'list-ordered',
	filenameExtension: '.coglens.passes',
	documentLanguage: 'artifact',
	renderer: renderOptimizationPipeline,
	metricLabels: {
		passCount: 'Pass count',
		changedPassCount: 'Passes that changed the function',
		machinePassCount: 'Machine code passes',
	},
} as const satisfies ArtifactDefinition;
