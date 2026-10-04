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
	editorLanguageId: 'coglens-asm',
	renderer: renderBinaryDisassembly,
} as const satisfies ArtifactDefinition;
