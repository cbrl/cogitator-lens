import type { ArtifactDefinition } from '../core/artifact-contracts.js';
import { renderRustMir } from './rust-mir-renderer.js';

export const rustMirArtifact = {
	label: 'Rust MIR',
	options: [],
	presentation: 'text',
	generatedCode: true,
	icon: 'symbol-namespace',
	filenameExtension: '.coglens.mir',
	documentLanguage: 'artifact',
	editorLanguageId: 'coglens-mir',
	renderer: renderRustMir,
} as const satisfies ArtifactDefinition;
