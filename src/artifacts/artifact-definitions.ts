import type {
	ArtifactOptions,
	DisplayOptions,
	RawArtifact,
	RenderedArtifactLine,
	RenderedArtifact,
} from '../types/index.js';
import type { ToolchainBackend } from '../toolchains/toolchain-backend.js';
import type { ParsedAsmResultLine } from '../vendor/types/asmresult/asmresult.interfaces.js';
import type { ParsedAsmResult } from '../vendor/types/asmresult/asmresult.interfaces.js';
import { renderLlvmIr } from './llvm-ir-renderer.js';
import { renderOptimizationRemarks } from './optimization-remarks-renderer.js';
import { renderedArtifact } from './rendered-artifact.js';

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

interface ArtifactDefinitionShape {
	readonly label: string;
	readonly filenameExtension: string;
	readonly options: readonly ArtifactOptionDescriptor[];
	readonly renderer: (
		raw: RawArtifact,
		options: DisplayOptions,
		backend: ToolchainBackend,
	) => RenderedArtifact | Promise<RenderedArtifact>;
	readonly navigation: ArtifactNavigationFeatures;
}

const displayOptionDescriptors = {
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
] as const satisfies readonly ArtifactOptionDescriptor[];

const binaryDisassemblyOptions = [
	displayOptionDescriptors.labels,
	displayOptionDescriptors.libraryCode,
	displayOptionDescriptors.dontMaskFilenames,
] as const satisfies readonly ArtifactOptionDescriptor[];

export const artifactDefinitions = {
	assembly: {
		label: 'Assembly',
		filenameExtension: '.asm',
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
		label: 'Binary disassembly',
		filenameExtension: '.disasm',
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
	'llvm-ir': {
		label: 'LLVM IR',
		filenameExtension: '.ll',
		options: [],
		renderer: renderLlvmIr,
		navigation: {
			definitions: true,
			sourceLocations: true,
			links: false,
			folds: true,
			symbols: true,
		},
	},
	'optimization-remarks': {
		label: 'Optimization remarks',
		filenameExtension: '.opt',
		options: [],
		renderer: renderOptimizationRemarks,
		navigation: {
			definitions: true,
			sourceLocations: true,
			links: false,
			folds: false,
			symbols: false,
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

function renderAssembly(
	raw: RawArtifact,
	options: DisplayOptions,
	backend: ToolchainBackend,
): RenderedArtifact {
	const parsed = backend.parseAssembly(raw.text, options);
	const lines = parsed.asm.map(parsedLine);
	return withLabelNavigation(renderedArtifact(raw, lines, {
		labelDefinitions: parsed.labelDefinitions,
	}), parsed);
}

function renderBinaryDisassembly(
	raw: RawArtifact,
	options: DisplayOptions,
	backend: ToolchainBackend,
): RenderedArtifact {
	const parsed = backend.parseBinaryDisassembly(raw.text, options);
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
	artifact: RenderedArtifact,
	parsed: ParsedAsmResult,
): RenderedArtifact {
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
