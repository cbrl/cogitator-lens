import type {
	ArtifactOptions,
	DisplayOptions,
	RawArtifact,
	RenderedArtifactLine,
	RenderedArtifact,
	RenderedTextArtifact,
} from '../../types/index.js';
import type { ToolchainBackend } from '../../toolchains/toolchain-backend.js';
import type { Uri } from 'vscode';
import type { ParsedAsmResultLine } from '../../vendor/types/asmresult/asmresult.interfaces.js';
import type { ParsedAsmResult } from '../../vendor/types/asmresult/asmresult.interfaces.js';
import { renderLlvmIr } from '../llvm-ir/llvm-ir-renderer.js';
import { renderPythonBytecode } from '../python/python-bytecode-renderer.js';
import { renderedArtifact } from './rendered-artifact.js';
import { renderPreprocessedSource } from '../preprocessed-source/preprocessed-source-renderer.js';
import { renderRustMir } from '../rust/rust-mir-renderer.js';
import { renderNativeStackAnalysis } from '../stack-analysis/native-stack-analysis.js';
import { renderControlFlowGraphArtifact } from '../control-flow-graph/control-flow-graph-renderer.js';

export interface ArtifactOptionDescriptor {
	readonly id: keyof ArtifactOptions['production'] | keyof ArtifactOptions['display'];
	readonly group: 'production' | 'display';
	readonly label: string;
	readonly description: string;
}

export interface ArtifactNavigationFeatures {
	readonly definitions: boolean;
	readonly sourceLocations: boolean;
	readonly links: boolean;
	readonly folds: boolean;
	readonly symbols: boolean;
}

export interface ArtifactRenderContext {
	readonly backend: ToolchainBackend;
	/** The compiler output selected for an output-backed artifact. */
	readonly artifactOutputId?: string;
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

interface ArtifactDefinitionShape {
	readonly presentation: 'text' | 'graph';
	readonly label: string;
	readonly filenameExtension: string;
	readonly documentLanguage: 'artifact' | 'source';
	readonly options: readonly ArtifactOptionDescriptor[];
	readonly renderer: ArtifactRenderer;
	readonly navigation: ArtifactNavigationFeatures;
	readonly metricLabels?: Readonly<Record<string, string>>;
}

const displayOptionDescriptors = {
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

const binaryDisassemblyOptions = [
	displayOptionDescriptors.labels,
	displayOptionDescriptors.libraryCode,
	displayOptionDescriptors.dontMaskFilenames,
	displayOptionDescriptors.binaryColumns,
	displayOptionDescriptors.sourceLineColorBands,
] as const satisfies readonly ArtifactOptionDescriptor[];

export const artifactDefinitions = {
	assembly: {
		presentation: 'text',
		label: 'Assembly',
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
	},
	'binary-disassembly': {
		presentation: 'text',
		label: 'Binary disassembly',
		filenameExtension: '.disasm',
		documentLanguage: 'artifact',
		options: binaryDisassemblyOptions,
		renderer: renderBinaryDisassembly,
		navigation: {
			definitions: true,
			sourceLocations: true,
			links: true,
			folds: true,
			symbols: true,
		},
	},
	'preprocessed-source': {
		presentation: 'text',
		label: 'Preprocessed source',
		filenameExtension: '.preprocessed',
		documentLanguage: 'source',
		options: [displayOptionDescriptors.showIncludedFiles],
		renderer: renderPreprocessedSource,
		navigation: {
			definitions: true,
			sourceLocations: true,
			links: false,
			folds: true,
			symbols: false,
		},
	},
	ast: {
		presentation: 'text',
		label: 'Abstract syntax tree',
		filenameExtension: '.ast',
		documentLanguage: 'artifact',
		options: [displayOptionDescriptors.showSystemDeclarations],
		renderer: renderToolchainArtifact,
		navigation: {
			definitions: true,
			sourceLocations: true,
			links: false,
			folds: true,
			symbols: true,
		},
	},
	'llvm-ir': {
		presentation: 'text',
		label: 'LLVM IR',
		filenameExtension: '.ll',
		documentLanguage: 'artifact',
		options: [displayOptionDescriptors.sourceLineColorBands],
		renderer: renderLlvmIr,
		navigation: {
			definitions: true,
			sourceLocations: true,
			links: false,
			folds: true,
			symbols: true,
		},
	},
	'rust-mir': {
		presentation: 'text',
		label: 'Rust MIR',
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
	},
	'optimization-remarks': {
		presentation: 'text',
		label: 'Optimization remarks',
		filenameExtension: '.opt',
		documentLanguage: 'source',
		options: [],
		renderer: renderToolchainArtifact,
		navigation: {
			definitions: true,
			sourceLocations: true,
			links: false,
			folds: false,
			symbols: false,
		},
	},
	'stack-analysis': {
		presentation: 'text',
		label: 'Stack analysis',
		filenameExtension: '.stack',
		documentLanguage: 'source',
		options: [],
		renderer: renderNativeStackAnalysis,
		navigation: {
			definitions: true,
			sourceLocations: true,
			links: false,
			folds: false,
			symbols: false,
		},
		metricLabels: {
			functionCount: 'Function count',
			largestFrame: 'Largest known frame',
			largestFrameUnit: 'Largest frame unit',
			totalKnownFrame: 'Total known frame',
			totalKnownFrameUnit: 'Total frame unit',
			dynamicFrameCount: 'Dynamic frame count',
			unmappedEntryCount: 'Unmapped entry count',
		},
	},
	'python-bytecode': {
		presentation: 'text',
		label: 'Python bytecode',
		filenameExtension: '.pybytecode',
		documentLanguage: 'artifact',
		options: [],
		renderer: renderPythonBytecode,
		navigation: {
			definitions: true,
			sourceLocations: true,
			links: false,
			folds: false,
			symbols: false,
		},
	},
	'control-flow-graph': {
		presentation: 'graph',
		label: 'Control-flow graph',
		filenameExtension: '.cfg',
		documentLanguage: 'artifact',
		options: [],
		renderer: renderControlFlowGraphArtifact,
		navigation: {
			definitions: false,
			sourceLocations: false,
			links: false,
			folds: false,
			symbols: false,
		},
		metricLabels: {
			graphCount: 'Function graphs',
			nodeCount: 'Basic blocks',
			edgeCount: 'Control-flow edges',
			branchNodeCount: 'Branch blocks',
			unreachableNodeCount: 'Unreachable blocks',
			sourceMappedNodeCount: 'Source-mapped blocks',
		},
	},
} as const satisfies Record<string, ArtifactDefinitionShape>;

export type ArtifactKind = keyof typeof artifactDefinitions;
export type ArtifactDefinition = (typeof artifactDefinitions)[ArtifactKind];

export const supportedArtifactKinds = Object.freeze(
	Object.keys(artifactDefinitions) as ArtifactKind[],
);

export function getArtifactDefinition(kind: string): ArtifactDefinition | undefined {
	return Object.hasOwn(artifactDefinitions, kind)
		? artifactDefinitions[kind as ArtifactKind]
		: undefined;
}

export function artifactSupportsOption(
	kind: ArtifactKind,
	optionId: ArtifactOptionDescriptor['id'],
): boolean {
	const definition: ArtifactDefinitionShape = artifactDefinitions[kind];
	return definition.options.some(option => option.id === optionId);
}

function renderToolchainArtifact(
	raw: RawArtifact,
	options: DisplayOptions,
	context: ArtifactRenderContext,
): RenderedTextArtifact {
	const artifact = context.backend.renderArtifact(raw, options, context);
	if (artifact.presentation !== 'text') {
		throw new Error(`Expected a text renderer for ${raw.kind}.`);
	}
	return artifact;
}

function renderAssembly(
	raw: RawArtifact,
	options: DisplayOptions,
	context: ArtifactRenderContext,
): RenderedTextArtifact {
	const parsed = context.backend.parseAssembly(raw.text, options);
	const lines = parsed.asm.map(parsedLine);
	return withLabelNavigation(renderedArtifact(raw, lines, {
		labelCount: Object.keys(parsed.labelDefinitions ?? {}).length,
	}), parsed);
}

function renderBinaryDisassembly(
	raw: RawArtifact,
	options: DisplayOptions,
	context: ArtifactRenderContext,
): RenderedTextArtifact {
	const parsed = context.backend.parseBinaryDisassembly(raw.text, options);
	const lines = parsed.asm.map(parsedLine);
	return withLabelNavigation(renderedArtifact(raw, lines, {
			codeSizeBytes: parsed.asm.reduce(
				(total, line) => total + (line.opcodes?.length ?? 0),
				0,
			),
			instructionCount: parsed.asm.filter(line => line.opcodes?.length).length,
		}), parsed);
}

function withLabelNavigation(
	artifact: RenderedTextArtifact,
	parsed: ParsedAsmResult,
): RenderedTextArtifact {
	const definitions = parsed.labelDefinitions ?? {};
	const links = parsed.asm.flatMap((line, lineIndex) =>
		(line.labels ?? []).flatMap(label => {
			const targetLine = definitions[label.target ?? label.name];
			return targetLine === undefined
				? []
				: [{
					line: lineIndex,
					startCharacter: label.range.startCol,
					endCharacter: label.range.endCol,
					targetLine,
				}];
		}),
	);
	const symbols = Object.entries(definitions)
		.map(([name, line]) => ({ name, line }))
		.sort((left, right) => left.line - right.line || left.name.localeCompare(right.name));
	const boundaryLines = [...new Set(symbols.map(symbol => symbol.line))]
		.filter(line => line >= 0 && line < artifact.lines.length)
		.sort((left, right) => left - right);
	const folds = boundaryLines.flatMap((startLine, index) => {
		const endLine = (boundaryLines[index + 1] ?? artifact.lines.length) - 1;
		return endLine > startLine ? [{ startLine, endLine }] : [];
	});
	return { ...artifact, links, folds, symbols };
}

function parsedLine(line: ParsedAsmResultLine): RenderedArtifactLine {
	return {
		text: line.text,
		opcodes: line.opcodes ? [...line.opcodes] : undefined,
		address: line.address,
		disassembly: line.disassembly ?? (line.opcodes ? line.text.trimStart() : undefined),
		source: line.source
			? {
				file: line.source.file,
				line: line.source.line,
				column: line.source.column,
				mainSource: line.source.mainsource,
			}
			: line.source,
	};
}

export type ArtifactOptionAvailability =
	| { readonly status: 'available' }
	| {
		readonly status: 'unavailable' | 'unsupported';
		readonly explanation: string;
		/** Machine-readable reason code for statuses a caller needs to branch on directly. */
		readonly reason?: 'inherent';
	};
