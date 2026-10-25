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
