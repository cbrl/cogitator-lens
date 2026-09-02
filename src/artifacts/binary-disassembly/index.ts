import { displayOptionDescriptors, type ArtifactDefinition } from '../core/artifact-contracts.js';
import { renderBinaryDisassembly } from './binary-disassembly-renderer.js';

export const binaryDisassemblyArtifact = {
	label: 'Binary disassembly',
	options: [
		displayOptionDescriptors.labels,
		displayOptionDescriptors.libraryCode,
		displayOptionDescriptors.dontMaskFilenames,
		displayOptionDescriptors.binaryColumns,
		displayOptionDescriptors.sourceLineColorBands,
	],
	presentation: 'text',
	listingSyntax: 'native-assembly',
	icon: 'package',
	filenameExtension: '.disasm',
	documentLanguage: 'artifact',
	renderer: renderBinaryDisassembly,
	navigation: {
		definitions: true,
		sourceLocations: true,
		links: true,
		folds: true,
		symbols: true,
	},
} as const satisfies ArtifactDefinition;
