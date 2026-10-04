import type { ArtifactDefinition } from '../core/artifact-contracts.js';

export const optimizationRemarksArtifact = {
	label: 'Optimization remarks',
	options: [],
	presentation: 'text',
	icon: 'lightbulb',
	filenameExtension: '.opt',
	documentLanguage: 'source',
} as const satisfies ArtifactDefinition;
