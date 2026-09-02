import { displayOptionDescriptors, type ArtifactDefinition, type ArtifactOptionDescriptor } from '../core/artifact-contracts.js';
import { renderAssembly } from './assembly-renderer.js';

const assemblyOptions = [
	{
		id: 'intel',
		group: 'production',
		label: 'Intel syntax',
		description: 'Emit Intel syntax when supported by the selected toolchain',
	},
	{
		id: 'demangle',
		group: 'production',
		label: 'Demangle symbols',
		description: 'Run the configured demangler before rendering assembly',
	},
	displayOptionDescriptors.labels,
	displayOptionDescriptors.libraryCode,
	{
		id: 'directives',
		group: 'display',
		label: 'Hide directives',
		description: 'Hide assembler directives',
	},
	{
		id: 'commentOnly',
		group: 'display',
		label: 'Hide comment-only lines',
		description: 'Remove comment-only lines',
	},
	{
		id: 'trim',
		group: 'display',
		label: 'Trim horizontal whitespace',
		description: 'Remove excessive horizontal whitespace',
	},
	displayOptionDescriptors.dontMaskFilenames,
	displayOptionDescriptors.binaryColumns,
	displayOptionDescriptors.sourceLineColorBands,
] as const satisfies readonly ArtifactOptionDescriptor[];

export const assemblyArtifact = {
	presentation: 'text',
	listingSyntax: 'native-assembly',
	label: 'Assembly',
	icon: 'symbol-method',
	filenameExtension: '.asm',
	documentLanguage: 'artifact',
	options: assemblyOptions,
	renderer: renderAssembly,
	navigation: {
		definitions: true,
		sourceLocations: true,
		links: true,
		folds: true,
		symbols: true,
	},
	metricLabels: {
		methodCount: 'Method count',
		codeObjectCount: 'Code object count',
		instructionCount: 'Instruction count',
		sourceLineCount: 'Mapped source lines',
		codeSizeBytes: 'Code size',
		labelCount: 'Label count',
	},
} as const satisfies ArtifactDefinition;
