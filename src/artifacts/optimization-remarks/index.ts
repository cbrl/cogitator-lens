import type { ArtifactDefinition } from '../core/artifact-contracts.js';
import { renderToolchainArtifact } from '../core/toolchain-rendered-artifact.js';

export const optimizationRemarksArtifact = {
	presentation: 'text',
	label: 'Optimization remarks',
	icon: 'lightbulb',
	filenameExtension: '.opt',
	documentLanguage: 'source',
	options: [],
	renderer: renderToolchainArtifact,
	navigation: {
		definitions: true,
		sourceLocations: true,
		links: false,
		folds: false,
		symbols: false,
	},
} as const satisfies ArtifactDefinition;
