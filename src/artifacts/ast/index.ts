import { displayOptionDescriptors, type ArtifactDefinition } from '../core/artifact-contracts.js';
import { renderToolchainArtifact } from '../core/toolchain-rendered-artifact.js';

export const astArtifact = {
	label: 'Abstract syntax tree',
	options: [displayOptionDescriptors.showSystemDeclarations],
	presentation: 'text',
	icon: 'symbol-structure',
	filenameExtension: '.ast',
	documentLanguage: 'artifact',
	renderer: renderToolchainArtifact,
	navigation: {
		definitions: true,
		sourceLocations: true,
		links: false,
		folds: true,
		symbols: true,
	},
} as const satisfies ArtifactDefinition;
