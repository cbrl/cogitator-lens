import type { ArtifactDefinition } from '../core/artifact-contracts.js';
import { renderRustMir } from './rust-mir-renderer.js';

export const rustMirArtifact = {
	label: 'Rust MIR',
	options: [],
	presentation: 'text',
	icon: 'symbol-namespace',
	filenameExtension: '.mir',
	documentLanguage: 'artifact',
	editorLanguageId: 'coglens-mir',
	renderer: renderRustMir,
} as const satisfies ArtifactDefinition;
