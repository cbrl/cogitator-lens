import type {
	ArtifactOptions,
	DisplayOptions,
	RawArtifact,
	RenderedArtifactLine,
	RenderedArtifact,
} from '../types/index.js';
import type { ToolchainBackend } from '../toolchains/toolchain-backend.js';
import type { ParsedAsmResultLine } from '../vendor/types/asmresult/asmresult.interfaces.js';

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
	) => RenderedArtifact;
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

const noNavigation: ArtifactNavigationFeatures = Object.freeze({
	definitions: false,
	sourceLocations: false,
	links: false,
	folds: false,
	symbols: false,
});

export const artifactDefinitions = {
	assembly: {
		label: 'Assembly',
		filenameExtension: '.asm',
		options: assemblyOptions,
		renderer: renderAssembly,
		navigation: {
			definitions: true,
			sourceLocations: true,
			links: false,
			folds: false,
			symbols: false,
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
			folds: false,
			symbols: true,
		},
	},
	'llvm-ir': {
		label: 'LLVM IR',
		filenameExtension: '.ll',
		options: [],
		renderer: renderPlainText,
		navigation: noNavigation,
	},
	'optimization-remarks': {
		label: 'Optimization remarks',
		filenameExtension: '.opt.yaml',
		options: [],
		renderer: renderPlainText,
		navigation: noNavigation,
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
	return renderedArtifact(raw, lines, {
		labelDefinitions: parsed.labelDefinitions,
	});
}

function renderBinaryDisassembly(
	raw: RawArtifact,
	options: DisplayOptions,
	backend: ToolchainBackend,
): RenderedArtifact {
	const parsed = backend.parseBinaryDisassembly(raw.text, options);
	const lines = parsed.asm.map(parsedLine);
	const links = parsed.asm.flatMap((line, lineIndex) =>
		(line.labels ?? []).flatMap(label => {
			const targetLine = parsed.labelDefinitions?.[label.name];
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
	const symbols = Object.entries(parsed.labelDefinitions ?? {}).map(([name, line]) => ({
		name,
		line,
	}));
	return {
		...renderedArtifact(raw, lines, {
			codeSizeBytes: parsed.asm.reduce(
				(total, line) => total + (line.opcodes?.length ?? 0),
				0,
			),
			instructionCount: parsed.asm.filter(line => line.opcodes?.length).length,
		}),
		links,
		symbols,
	};
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

function renderPlainText(
	raw: RawArtifact,
	_options: DisplayOptions,
	_backend: ToolchainBackend,
): RenderedArtifact {
	return renderedArtifact(
		raw,
		raw.text.split(/\r?\n/).map(text => ({ text })),
	);
}

function renderedArtifact(
	raw: RawArtifact,
	lines: readonly RenderedArtifactLine[],
	metrics: Readonly<Record<string, unknown>> = {},
): RenderedArtifact {
	return {
		kind: raw.kind,
		lines,
		sourceLocations: lines.flatMap((line, lineIndex) => {
			const sourceLine = line.source?.line;
			return line.source?.file && sourceLine !== undefined && sourceLine !== null
				? [{
					line: lineIndex,
					uri: line.source.file,
					sourceLine,
				}]
				: [];
		}),
		links: [],
		folds: [],
		symbols: [],
		metrics,
		raw,
		truncated: raw.truncated || lines.some(line =>
			line.text.includes('[truncated; too many lines]')),
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
