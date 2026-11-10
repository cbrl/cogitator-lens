import type { Uri } from 'vscode';
import type { ToolchainBackend } from '../../toolchains/toolchain-backend.js';
import type { ArtifactOptions, DisplayOptions, RawArtifact, RenderedArtifact } from '../../types/index.js';
import type { ArtifactEditorLanguageId } from './editor-languages.js';

export interface ArtifactOptionDescriptor {
	readonly id: keyof ArtifactOptions['production'] | keyof ArtifactOptions['display'];
	readonly group: 'production' | 'display';
	readonly label: string;
	readonly description: string;
	/** Changes only editor decorations, so the artifact is redrawn rather than rendered again. */
	readonly decorationOnly?: true;
}

export interface ArtifactRenderContext {
	readonly backend: ToolchainBackend;
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
	| 'control-flow-graph'
	| 'optimization-pipeline'
	| 'machine-code-analysis'
	| 'code-size';

/** How a rendered text listing is written, for mnemonic and token analysis. */
export type ArtifactListingSyntax = 'native-assembly' | 'python-bytecode' | 'dotnet-il' | 'java-bytecode' | 'llvm-ir';

export interface ArtifactDefinition {
	readonly presentation: 'text' | 'graph';
	/**
	 * Whether the listing is code that the compiler generated from the source, with function symbols
	 * and local labels. Source navigation, function views, and normalized views use these kinds.
	 */
	readonly generatedCode?: true;
	/** Whether artifact document identities must select one named toolchain output. */
	readonly requiresOutputSelection?: true;
	/**
	 * Whether artifact document identities must name one function. The compile then prints its
	 * output for that function only, because the output of each function can be very large.
	 */
	readonly requiresFunctionFilter?: true;
	readonly label: string;
	readonly icon: string;
	/**
	 * The suffix of the artifact document name. An `artifact` document needs a private suffix, such as
	 * `.coglens.asm`. Its language contribution then cannot claim the user's own files.
	 */
	readonly filenameExtension: string;
	readonly documentLanguage: 'artifact' | 'source';
	/** Language contribution used for artifact-owned text document extensions. */
	readonly editorLanguageId?: ArtifactEditorLanguageId;
	readonly options: readonly ArtifactOptionDescriptor[];
	/**
	 * Option IDs that earlier versions used. Each one meant the opposite of the option it names, or
	 * `null` when it no longer has an effect: `"labels": true` hid unused labels, so it reads as
	 * `"showUnusedLabels": false`.
	 */
	readonly formerOptions?: Readonly<Record<string, ArtifactOptionDescriptor['id'] | null>>;
	/** Default renderer. Omit it when each toolchain implementation must declare its own. */
	readonly renderer?: ArtifactRenderer;
	/** Default listing syntax; a toolchain implementation may override it. */
	readonly listingSyntax?: ArtifactListingSyntax;
	readonly metricLabels?: Readonly<Record<string, string>>;
}

export const productionOptionDescriptors = {
	intel: {
		id: 'intel',
		group: 'production',
		label: 'Intel syntax',
		description: 'Emit Intel syntax when supported by the selected toolchain',
	},
	demangle: {
		id: 'demangle',
		group: 'production',
		label: 'Demangle symbols',
		description: 'Run the configured demangler on the output before it is shown',
	},
} as const satisfies Record<string, ArtifactOptionDescriptor>;

export const displayOptionDescriptors = {
	binaryColumns: {
		id: 'binaryColumns',
		group: 'display',
		label: 'Show address and opcode columns',
		description: 'Show parsed instruction addresses and encoded bytes beside the listing',
		decorationOnly: true,
	},
	sourceLineColorBands: {
		id: 'sourceLineColorBands',
		group: 'display',
		label: 'Show source-line color bands',
		description: 'Use stable color bands to connect source lines with generated output',
		decorationOnly: true,
	},
	showUnusedLabels: {
		id: 'showUnusedLabels',
		group: 'display',
		label: 'Show unused labels',
		description: 'Keep labels that no instruction references',
	},
	showLibraryCode: {
		id: 'showLibraryCode',
		group: 'display',
		label: 'Show library code',
		description: 'Show functions whose code comes only from headers and libraries',
	},
	showIncludedFiles: {
		id: 'showIncludedFiles',
		group: 'display',
		label: 'Show included files',
		description: 'Include content originating from headers in preprocessed output',
	},
	showUnchangedPasses: {
		id: 'showUnchangedPasses',
		group: 'display',
		label: 'Show unchanged passes',
		description: 'List each pass of the pipeline, also the passes that did not change the function',
	},
	showSystemDeclarations: {
		id: 'showSystemDeclarations',
		// The Clang producer drops system declarations, so showing them compiles again.
		group: 'production',
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
