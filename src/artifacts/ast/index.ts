import { displayOptionDescriptors, type ArtifactDefinition } from '../core/artifact-contracts.js';

export const astArtifact = {
	label: 'Abstract syntax tree',
	options: [displayOptionDescriptors.showSystemDeclarations],
	presentation: 'text',
	icon: 'symbol-structure',
	filenameExtension: '.coglens.ast',
	documentLanguage: 'artifact',
	editorLanguageId: 'coglens-ast',
} as const satisfies ArtifactDefinition;
