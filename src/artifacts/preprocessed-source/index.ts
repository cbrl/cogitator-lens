import { displayOptionDescriptors, type ArtifactDefinition } from '../core/artifact-contracts.js';
import { renderPreprocessedSource } from './preprocessed-source-renderer.js';

export const preprocessedSourceArtifact = {
	label: 'Preprocessed source',
	options: [displayOptionDescriptors.showIncludedFiles],
	presentation: 'text',
	icon: 'file-code',
	filenameExtension: '.preprocessed',
	documentLanguage: 'source',
	renderer: renderPreprocessedSource,
	navigation: {
		definitions: true,
		sourceLocations: true,
		links: false,
		folds: true,
		symbols: false,
	},
} as const satisfies ArtifactDefinition;
