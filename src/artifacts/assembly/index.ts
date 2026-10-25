import { displayOptionDescriptors, type ArtifactDefinition } from '../core/artifact-contracts.js';
import { renderAssembly } from './assembly-renderer.js';

export const assemblyArtifact = {
	label: 'Assembly',
	options: [
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
		displayOptionDescriptors.showUnusedLabels,
		displayOptionDescriptors.showLibraryCode,
		{
			id: 'showDirectives',
			group: 'display',
			label: 'Show directives',
			description: 'Show assembler directives',
		},
		{
			id: 'showCommentOnlyLines',
			group: 'display',
			label: 'Show comment-only lines',
			description: 'Keep lines that contain only a comment',
		},
		{
			id: 'trim',
			group: 'display',
			label: 'Trim horizontal whitespace',
			description: 'Remove excessive horizontal whitespace',
		},
		displayOptionDescriptors.binaryColumns,
		displayOptionDescriptors.sourceLineColorBands,
	],
	formerOptions: {
		labels: 'showUnusedLabels',
		libraryCode: 'showLibraryCode',
		directives: 'showDirectives',
		commentOnly: 'showCommentOnlyLines',
		dontMaskFilenames: null,
	},
	presentation: 'text',
	listingSyntax: 'native-assembly',
	icon: 'symbol-method',
	filenameExtension: '.asm',
	documentLanguage: 'artifact',
	editorLanguageId: 'coglens-asm',
	renderer: renderAssembly,
	metricLabels: {
		methodCount: 'Method count',
		codeObjectCount: 'Code object count',
		instructionCount: 'Instruction count',
		sourceLineCount: 'Mapped source lines',
		codeSizeBytes: 'Code size',
		labelCount: 'Label count',
	},
} as const satisfies ArtifactDefinition;
