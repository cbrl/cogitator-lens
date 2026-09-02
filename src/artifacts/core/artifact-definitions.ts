import type {
	DisplayOptions,
	RawArtifact,
	RenderedArtifactLine,
	RenderedArtifact,
	RenderedTextArtifact,
} from '../../types/index.js';
import {
	displayOptionDescriptors,
	type ArtifactDefinition,
	type ArtifactKind,
	type ArtifactOptionDescriptor,
	type ArtifactRenderContext,
} from './artifact-contracts.js';
import type { ParsedAsmResultLine } from '../../vendor/types/asmresult/asmresult.interfaces.js';
import type { ParsedAsmResult } from '../../vendor/types/asmresult/asmresult.interfaces.js';
import { renderLlvmIr } from '../llvm-ir/llvm-ir-renderer.js';
import { renderedArtifact } from './rendered-artifact.js';
import { renderPreprocessedSource } from '../preprocessed-source/preprocessed-source-renderer.js';
import { renderRustMir } from '../rust/rust-mir-renderer.js';
import { renderNativeStackAnalysis } from '../stack-analysis/native-stack-analysis.js';
import { renderControlFlowGraphArtifact } from '../control-flow-graph/control-flow-graph-renderer.js';
import type { InstructionType } from '../control-flow-graph/parsers/instruction-sets.js';

export type {
	ArtifactDefinition,
	ArtifactKind,
	ArtifactListingSyntax,
	ArtifactNavigationFeatures,
	ArtifactOptionAvailability,
	ArtifactOptionDescriptor,
	ArtifactRenderContext,
	ArtifactRenderer,
} from './artifact-contracts.js';

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

const artifactDefinitionTable = {
	assembly: {
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
	},
	'binary-disassembly': {
		presentation: 'text',
		listingSyntax: 'native-assembly',
		label: 'Binary disassembly',
		icon: 'package',
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
		icon: 'file-code',
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
		icon: 'symbol-structure',
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
		listingSyntax: 'llvm-ir',
		label: 'LLVM IR',
		icon: 'circuit-board',
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
	},
	'optimization-remarks': {
		presentation: 'text',
		label: 'Optimization remarks',
		icon: 'lightbulb',
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
		icon: 'layers',
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
	'control-flow-graph': {
		presentation: 'graph',
		requiresOutputSelection: true,
		label: 'Control-flow graph',
		icon: 'type-hierarchy',
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
} as const satisfies Record<ArtifactKind, ArtifactDefinition>;

export const artifactDefinitions: typeof artifactDefinitionTable & Record<ArtifactKind, ArtifactDefinition> =
	artifactDefinitionTable;

export const supportedArtifactKinds = Object.freeze(Object.keys(artifactDefinitions) as ArtifactKind[]);

export function getArtifactDefinition(kind: string): ArtifactDefinition | undefined {
	return Object.hasOwn(artifactDefinitions, kind) ? artifactDefinitions[kind as ArtifactKind] : undefined;
}

export function getArtifactKind(value: string): ArtifactKind | undefined {
	return getArtifactDefinition(value) ? (value as ArtifactKind) : undefined;
}

export function artifactSupportsOption(kind: ArtifactKind, optionId: ArtifactOptionDescriptor['id']): boolean {
	const definition = artifactDefinitions[kind];
	return definition.options.some((option) => option.id === optionId);
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
	return withLabelNavigation(
		renderedArtifact(raw, lines, {
			labelCount: Object.keys(parsed.labelDefinitions ?? {}).length,
		}),
		parsed,
		(instruction) => context.backend.classifyAssemblyInstruction(instruction),
	);
}

function renderBinaryDisassembly(
	raw: RawArtifact,
	options: DisplayOptions,
	context: ArtifactRenderContext,
): RenderedTextArtifact {
	const parsed = context.backend.parseBinaryDisassembly(raw.text, options);
	const lines = parsed.asm.map(parsedLine);
	return withLabelNavigation(
		renderedArtifact(raw, lines, {
			codeSizeBytes: parsed.asm.reduce((total, line) => total + (line.opcodes?.length ?? 0), 0),
			instructionCount: parsed.asm.filter((line) => line.opcodes?.length).length,
		}),
		parsed,
		(instruction) => context.backend.classifyAssemblyInstruction(instruction),
	);
}

function withLabelNavigation(
	artifact: RenderedTextArtifact,
	parsed: ParsedAsmResult,
	classifyInstruction: (instruction: string) => InstructionType | undefined,
): RenderedTextArtifact {
	const definitions = parsed.labelDefinitions ?? {};
	const links = parsed.asm.flatMap((line, lineIndex) =>
		(line.labels ?? []).flatMap((label) => {
			const targetLine = definitions[label.target ?? label.name];
			const instructionType = classifyInstruction(line.disassembly ?? line.text);
			const edgeKind =
				instructionType === 'unconditional-jump'
					? ('unconditional' as const)
					: instructionType === 'conditional-jump'
						? ('true' as const)
						: undefined;
			return targetLine === undefined
				? []
				: [
						{
							line: lineIndex,
							startCharacter: label.range.startCol,
							endCharacter: label.range.endCol,
							targetLine,
							...(edgeKind ? { edgeKind } : {}),
						},
					];
		}),
	);
	const symbols = Object.entries(definitions)
		.map(([name, line]) => ({ name, line }))
		.sort((left, right) => left.line - right.line || left.name.localeCompare(right.name));
	const boundaryLines = [...new Set(symbols.map((symbol) => symbol.line))]
		.filter((line) => line >= 0 && line < artifact.lines.length)
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
