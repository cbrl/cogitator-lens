import { displayOptionDescriptors, type ArtifactDefinition } from '../core/artifact-contracts.js';
import { renderLlvmIr } from './llvm-ir-renderer.js';

export const llvmIrArtifact = {
	label: 'LLVM IR',
	options: [displayOptionDescriptors.sourceLineColorBands],
	presentation: 'text',
	generatedCode: true,
	listingSyntax: 'llvm-ir',
	icon: 'circuit-board',
	filenameExtension: '.coglens.ll',
	documentLanguage: 'artifact',
	editorLanguageId: 'coglens-llvm-ir',
	renderer: renderLlvmIr,
} as const satisfies ArtifactDefinition;
