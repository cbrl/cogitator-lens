import { displayOptionDescriptors, type ArtifactDefinition } from '../core/artifact-contracts.js';
import { renderLlvmIr } from './llvm-ir-renderer.js';

export const llvmIrArtifact = {
	presentation: 'text',
	listingSyntax: 'llvm-ir',
	label: 'LLVM IR',
	icon: 'circuit-board',
	filenameExtension: '.ll',
	documentLanguage: 'artifact',
	options: [displayOptionDescriptors.sourceLineColorBands],
	renderer: renderLlvmIr,
	navigation: {
		definitions: true,
		sourceLocations: true,
		links: false,
		folds: true,
		symbols: true,
	},
} as const satisfies ArtifactDefinition;
