import type { ArtifactDefinition } from '../core/artifact-contracts.js';
import { renderRustMir } from './rust-mir-renderer.js';

export const rustMirArtifact = {
	presentation: 'text',
	label: 'Rust MIR',
	icon: 'symbol-namespace',
	filenameExtension: '.mir',
	documentLanguage: 'artifact',
	options: [],
	renderer: renderRustMir,
	navigation: {
		definitions: true,
		sourceLocations: true,
		links: true,
		folds: true,
		symbols: true,
	},
} as const satisfies ArtifactDefinition;
