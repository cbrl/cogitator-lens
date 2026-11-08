import { productionOptionDescriptors, type ArtifactDefinition } from '../core/artifact-contracts.js';
import { renderMachineCodeAnalysis } from './analysis-renderer.js';

export const machineCodeAnalysisArtifact = {
	label: 'Machine code analysis',
	options: [productionOptionDescriptors.intel, productionOptionDescriptors.demangle],
	presentation: 'text',
	icon: 'pulse',
	filenameExtension: '.coglens.mca',
	documentLanguage: 'artifact',
	renderer: renderMachineCodeAnalysis,
	metricLabels: {
		regionCount: 'Functions',
		mappedRowCount: 'Rows with a source line',
	},
} as const satisfies ArtifactDefinition;
