import type { Uri } from 'vscode';
import type { ToolchainBackend } from '../../toolchains/toolchain-backend.js';
import type { ToolchainArtifactOutput } from '../../toolchains/toolchain-contracts.js';
import type { ArtifactOptions, DisplayOptions, RawArtifact, RenderedArtifact } from '../../types/index.js';
import type { ArtifactEditorLanguageId } from './editor-languages.js';

export interface ArtifactOptionDescriptor {
	readonly id: keyof ArtifactOptions['production'] | keyof ArtifactOptions['display'];
	readonly group: 'production' | 'display';
	readonly label: string;
	readonly description: string;
}

export interface ArtifactRenderContext {
	readonly backend: ToolchainBackend;
	/** The resolved compiler output selected for an output-backed artifact. */
	readonly artifactOutput?: ToolchainArtifactOutput;
	readonly source: {
		readonly uri: Uri;
		readonly text: string;
	};
}

export type ArtifactRenderer = (
	raw: RawArtifact,
	options: DisplayOptions,
	context: ArtifactRenderContext,
) => RenderedArtifact | Promise<RenderedArtifact>;

export type ArtifactKind =
	| 'assembly'
	| 'binary-disassembly'
	| 'preprocessed-source'
	| 'ast'
	| 'llvm-ir'
	| 'rust-mir'
	| 'optimization-remarks'
	| 'stack-analysis'
	| 'control-flow-graph';

/** How a rendered text listing is written, for mnemonic and token analysis. */
export type ArtifactListingSyntax = 'native-assembly' | 'python-bytecode' | 'dotnet-il' | 'llvm-ir';

export interface ArtifactDefinition {
	readonly presentation: 'text' | 'graph';
	/** Whether artifact document identities must select one named toolchain output. */
	readonly requiresOutputSelection?: true;
	readonly label: string;
	readonly icon: string;
	readonly filenameExtension: string;
	readonly documentLanguage: 'artifact' | 'source';
	/** Language contribution used for artifact-owned text document extensions. */
	readonly editorLanguageId?: ArtifactEditorLanguageId;
	readonly options: readonly ArtifactOptionDescriptor[];
	readonly renderer: ArtifactRenderer;
	/** Default listing syntax; a toolchain artifact cell may override it. */
	readonly listingSyntax?: ArtifactListingSyntax;
	readonly metricLabels?: Readonly<Record<string, string>>;
}

export const displayOptionDescriptors = {
	binaryColumns: {
		id: 'binaryColumns',
		group: 'display',
		label: 'Show address and opcode columns',
		description: 'Show parsed instruction addresses and encoded bytes beside the listing',
	},
	sourceLineColorBands: {
		id: 'sourceLineColorBands',
		group: 'display',
		label: 'Show source-line color bands',
		description: 'Use stable color bands to connect source lines with generated output',
	},
	labels: {
		id: 'labels',
		group: 'display',
		label: 'Hide unused labels',
		description: 'Remove labels that are not referenced',
	},
	libraryCode: {
		id: 'libraryCode',
		group: 'display',
		label: 'Hide library code',
		description: 'Hide code from system libraries',
	},
	dontMaskFilenames: {
		id: 'dontMaskFilenames',
		group: 'display',
		label: 'Show full filenames',
		description: 'Keep source filenames visible in rendered output',
	},
	showIncludedFiles: {
		id: 'showIncludedFiles',
		group: 'display',
		label: 'Show included files',
		description: 'Include content originating from headers in preprocessed output',
	},
	showSystemDeclarations: {
		id: 'showSystemDeclarations',
		group: 'display',
		label: 'Show system declarations',
		description: 'Include declarations originating from compiler and system headers',
	},
} as const satisfies Record<string, ArtifactOptionDescriptor>;

export type ArtifactOptionAvailability =
	| { readonly status: 'available' }
	| {
			readonly status: 'unavailable' | 'unsupported';
			readonly explanation: string;
			/** Machine-readable reason code for statuses a caller needs to branch on directly. */
			readonly reason?: 'inherent';
	  };
