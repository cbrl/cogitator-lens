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
} as const satisfies ArtifactDefinition;
