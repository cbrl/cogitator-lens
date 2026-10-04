import { displayOptionDescriptors, type ArtifactDefinition } from '../core/artifact-contracts.js';
import { renderToolchainArtifact } from '../core/toolchain-rendered-artifact.js';

export const astArtifact = {
	label: 'Abstract syntax tree',
	options: [displayOptionDescriptors.showSystemDeclarations],
	presentation: 'text',
	icon: 'symbol-structure',
	filenameExtension: '.ast',
	documentLanguage: 'artifact',
	editorLanguageId: 'coglens-ast',
	renderer: renderToolchainArtifact,
} as const satisfies ArtifactDefinition;
