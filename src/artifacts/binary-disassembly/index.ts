import { displayOptionDescriptors, type ArtifactDefinition, type ArtifactOptionDescriptor } from '../core/artifact-contracts.js';
import { renderBinaryDisassembly } from './binary-disassembly-renderer.js';

const binaryDisassemblyOptions = [
	displayOptionDescriptors.labels,
	displayOptionDescriptors.libraryCode,
	displayOptionDescriptors.dontMaskFilenames,
	displayOptionDescriptors.binaryColumns,
	displayOptionDescriptors.sourceLineColorBands,
] as const satisfies readonly ArtifactOptionDescriptor[];

export const binaryDisassemblyArtifact = {
	presentation: 'text',
	listingSyntax: 'native-assembly',
	label: 'Binary disassembly',
	icon: 'package',
	filenameExtension: '.disasm',
	documentLanguage: 'artifact',
	options: binaryDisassemblyOptions,
	renderer: renderBinaryDisassembly,
	navigation: {
		definitions: true,
		sourceLocations: true,
		links: true,
		folds: true,
		symbols: true,
	},
} as const satisfies ArtifactDefinition;
