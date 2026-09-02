import { displayOptionDescriptors, type ArtifactDefinition } from '../core/artifact-contracts.js';
import { renderLlvmIr } from './llvm-ir-renderer.js';

export const llvmIrArtifact = {
	label: 'LLVM IR',
	options: [displayOptionDescriptors.sourceLineColorBands],
	presentation: 'text',
	listingSyntax: 'llvm-ir',
	icon: 'circuit-board',
	filenameExtension: '.ll',
	documentLanguage: 'artifact',
	renderer: renderLlvmIr,
	navigation: {
		definitions: true,
		sourceLocations: true,
		links: false,
		folds: true,
		symbols: true,
	},
} as const satisfies ArtifactDefinition;
