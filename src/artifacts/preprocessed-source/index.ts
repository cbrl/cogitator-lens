import { displayOptionDescriptors, type ArtifactDefinition } from '../core/artifact-contracts.js';
import { renderPreprocessedSource } from './preprocessed-source-renderer.js';

export const preprocessedSourceArtifact = {
	presentation: 'text',
	label: 'Preprocessed source',
	icon: 'file-code',
	filenameExtension: '.preprocessed',
	documentLanguage: 'source',
	options: [displayOptionDescriptors.showIncludedFiles],
	renderer: renderPreprocessedSource,
	navigation: {
		definitions: true,
		sourceLocations: true,
		links: false,
		folds: true,
		symbols: false,
	},
} as const satisfies ArtifactDefinition;
