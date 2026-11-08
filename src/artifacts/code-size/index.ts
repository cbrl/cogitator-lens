import {
	displayOptionDescriptors,
	productionOptionDescriptors,
	type ArtifactDefinition,
} from '../core/artifact-contracts.js';
import { renderCodeSize } from './code-size-renderer.js';

export const codeSizeArtifact = {
	label: 'Code size',
	options: [productionOptionDescriptors.demangle, displayOptionDescriptors.showLibraryCode],
	presentation: 'text',
	icon: 'symbol-ruler',
	filenameExtension: '.coglens.size',
	documentLanguage: 'artifact',
	renderer: renderCodeSize,
	metricLabels: {
		functionCount: 'Functions',
		codeSizeBytes: 'Bytes of instructions',
		sectionBytes: 'Bytes of sections',
	},
} as const satisfies ArtifactDefinition;
