import { displayOptionDescriptors, type ArtifactDefinition } from '../core/artifact-contracts.js';
import { renderToolchainArtifact } from '../core/toolchain-rendered-artifact.js';

export const astArtifact = {
	presentation: 'text',
	label: 'Abstract syntax tree',
	icon: 'symbol-structure',
	filenameExtension: '.ast',
	documentLanguage: 'artifact',
	options: [displayOptionDescriptors.showSystemDeclarations],
	renderer: renderToolchainArtifact,
	navigation: {
		definitions: true,
		sourceLocations: true,
		links: false,
		folds: true,
		symbols: true,
	},
} as const satisfies ArtifactDefinition;
