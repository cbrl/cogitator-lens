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
} as const satisfies ArtifactDefinition;
