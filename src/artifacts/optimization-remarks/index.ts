import type { ArtifactDefinition } from '../core/artifact-contracts.js';
import { renderToolchainArtifact } from '../core/toolchain-rendered-artifact.js';

export const optimizationRemarksArtifact = {
	label: 'Optimization remarks',
	options: [],
	presentation: 'text',
	icon: 'lightbulb',
	filenameExtension: '.opt',
	documentLanguage: 'source',
	renderer: renderToolchainArtifact,
	navigation: {
		definitions: true,
		sourceLocations: true,
		links: false,
		folds: false,
		symbols: false,
	},
} as const satisfies ArtifactDefinition;
