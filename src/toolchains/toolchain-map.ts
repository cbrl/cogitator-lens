import fs from 'fs';
import path from 'path';
import type { CancellationToken, Uri } from 'vscode';
import type {
	ArtifactKind,
	ArtifactOptionAvailability,
	ArtifactOptionId,
	CompileOptions,
	IntelSyntaxSupport,
	RawArtifact,
	ToolchainKind,
	ToolchainProfile,
} from '../types/index.js';
import { ToolchainBackend } from '../toolchains/toolchain-backend.js';
import { AsmParser } from '../vendor/lib/parsers/asm-parser.js';
import { noopPropertyGetter } from '../vendor/compiler-props.js';
import {
	captureWindowsEnvironment,
	clangClOutputArguments,
	createMsvcAsmParser,
	msvcOutputArguments,
	windowsDemangle,
} from './msvc.js';
import { rustOutputArguments, stripRustManagedArguments } from './rust.js';
import {
	artifactDefinitions,
	supportedArtifactKinds,
} from '../artifacts/artifact-definitions.js';
import {
	binaryDisassemblyProducer,
	dumpbin,
	gnuObjdump,
	llvmObjdump,
} from '../artifacts/binary-disassembly-producer.js';
import {
	clangClLlvmIrOutput,
	clangClOptimizationRecord,
	clangOptimizationRecord,
	compilerOutputProducer,
	gccOptimizationRecord,
	llvmIrOutput,
} from '../artifacts/compiler-output-producer.js';

export type ToolCapabilityStatus = 'available' | 'unavailable' | 'unsupported';

export const disassemblerToolName = 'disassembler';

export type ArtifactProducer = (
	backend: ToolchainBackend,
	source: Uri,
	options: CompileOptions,
	cancellationToken: CancellationToken,
) => Promise<RawArtifact>;

export type ToolchainArtifactCell =
	| {
		readonly status: 'available';
		readonly producer: ArtifactProducer;
		readonly requiredTool?: {
			readonly name: string;
			readonly label: string;
		};
	}
	| {
		readonly status: 'unavailable' | 'unsupported';
		readonly explanation: string;
	};

export interface ToolchainDefinitionShape {
	readonly executablePattern: RegExp;
	readonly languageIdentifiers: readonly string[];
	readonly intelSyntax: IntelSyntaxSupport;
	readonly intelArguments?: readonly string[];
	readonly includeFlag?: string;
	readonly defineFlag?: string;
	readonly objectFilename: string;
	readonly outputArguments: (
		target: 'assembly' | 'object',
		outputFile: string,
		providerArguments: readonly string[],
	) => readonly string[];
	readonly stripOwnedArguments?: (
		args: readonly string[],
		sourceFile: string,
		workingDirectory: string,
	) => readonly string[];
	readonly createParser: () => AsmParser;
	readonly prepareEnvironment?: (
		profile: ToolchainProfile,
		environment: NodeJS.ProcessEnv,
		cancellationToken: CancellationToken,
	) => Promise<NodeJS.ProcessEnv>;
	readonly demangle?: (
		rawAssembly: string,
		demanglerTool: string,
		environment: NodeJS.ProcessEnv,
		workingDirectory: string,
		cancellationToken: CancellationToken,
	) => Promise<string>;
	readonly discoverTools: (executable: string) => Readonly<Record<string, string>>;
	readonly artifacts: Readonly<Record<ArtifactKind, ToolchainArtifactCell>>;
}

const cFamilyLanguageIdentifiers = Object.freeze([
	'c',
	'cpp',
	'objective-c',
	'objective-cpp',
	'cuda',
]);

const assemblyCell: ToolchainArtifactCell = {
	status: 'available',
	producer: (backend, source, options, cancellationToken) =>
		backend.produceAssembly(source, options, cancellationToken),
};

const binaryCell = (
	label: string,
	producer: ArtifactProducer,
): ToolchainArtifactCell => ({
	status: 'available',
	producer,
	requiredTool: {
		name: disassemblerToolName,
		label,
	},
});

function unsupportedCell(kind: ArtifactKind): ToolchainArtifactCell {
	return {
		status: 'unsupported',
		explanation: `This toolchain has no ${artifactDefinitions[kind].label.toLowerCase()} producer.`,
	};
}

function artifactCells(
	overrides: Partial<Record<ArtifactKind, ToolchainArtifactCell>>,
): Readonly<Record<ArtifactKind, ToolchainArtifactCell>> {
	return Object.freeze(Object.fromEntries(
		supportedArtifactKinds.map(kind => [kind, overrides[kind] ?? unsupportedCell(kind)]),
	)) as Readonly<Record<ArtifactKind, ToolchainArtifactCell>>;
}

const existingFile = (candidate: string): string | undefined =>
	fs.existsSync(candidate) ? candidate : undefined;
const sibling = (executable: string, name: string): string =>
	path.join(path.dirname(executable), name);
const toolExecutableName = (name: string): string =>
	process.platform === 'win32' ? `${name}.exe` : name;
const executableOnPath = (name: string): string | undefined => {
	for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
		if (directory) {
			const candidate = path.join(directory, name);
			if (fs.existsSync(candidate)) {
				return candidate;
			}
		}
	}
	return undefined;
};
const siblingOrPath = (executable: string, name: string): string | undefined =>
	existingFile(sibling(executable, name)) ?? executableOnPath(name);
const discoveredTools = (
	candidates: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> => Object.freeze(Object.fromEntries(
	Object.entries(candidates).filter(
		(entry): entry is [string, string] => entry[1] !== undefined,
	),
));

interface AuxiliaryToolNames {
	readonly demangler?: string;
	readonly disassembler?: string;
}

function toolDiscoverer(names: AuxiliaryToolNames): (executable: string) => Readonly<Record<string, string>> {
	return executable => discoveredTools({
		demangler: names.demangler
			? siblingOrPath(executable, toolExecutableName(names.demangler))
			: undefined,
		disassembler: names.disassembler
			? siblingOrPath(executable, toolExecutableName(names.disassembler))
			: undefined,
	});
}

function gnuOutputArguments(lineTableArguments: readonly string[]) {
	return (target: 'assembly' | 'object', outputFile: string): readonly string[] =>
		target === 'assembly'
			? ['-S', ...lineTableArguments, '-o', outputFile]
			: ['-c', ...lineTableArguments, '-o', outputFile];
}

const gnuIntelArguments = Object.freeze(['-masm=intel']);
const rustIntelArguments = Object.freeze(['-C', 'llvm-args=-x86-asm-syntax=intel']);

const defaultAsmParser = (): AsmParser => new AsmParser(noopPropertyGetter);

const clangArtifacts = artifactCells({
	assembly: assemblyCell,
	'binary-disassembly': binaryCell('llvm-objdump', binaryDisassemblyProducer(llvmObjdump)),
	'llvm-ir': {
		status: 'available',
		producer: compilerOutputProducer('llvm-ir', llvmIrOutput),
	},
	'optimization-remarks': {
		status: 'available',
		producer: compilerOutputProducer('optimization-remarks', clangOptimizationRecord),
	},
});

const gccArtifacts = artifactCells({
	assembly: assemblyCell,
	'binary-disassembly': binaryCell('GNU objdump', binaryDisassemblyProducer(gnuObjdump)),
	'optimization-remarks': {
		status: 'available',
		producer: compilerOutputProducer('optimization-remarks', gccOptimizationRecord),
	},
});

const msvcArtifacts = artifactCells({
	assembly: assemblyCell,
	'binary-disassembly': binaryCell('dumpbin', binaryDisassemblyProducer(dumpbin)),
});

const clangClArtifacts = artifactCells({
	assembly: assemblyCell,
	'binary-disassembly': binaryCell('llvm-objdump', binaryDisassemblyProducer(llvmObjdump)),
	'llvm-ir': {
		status: 'available',
		producer: compilerOutputProducer('llvm-ir', clangClLlvmIrOutput),
	},
	'optimization-remarks': {
		status: 'available',
		producer: compilerOutputProducer('optimization-remarks', clangClOptimizationRecord),
	},
});

const rustArtifacts = artifactCells({
	assembly: assemblyCell,
});

export const toolchainDefinitions = {
	gcc: {
		executablePattern: /^(?:gcc|g\+\+)(?:-\d+(?:\.\d+)*)?(?:\.exe)?$/i,
		languageIdentifiers: cFamilyLanguageIdentifiers,
		intelSyntax: 'selectable',
		intelArguments: gnuIntelArguments,
		includeFlag: '-I',
		defineFlag: '-D',
		objectFilename: 'output.o',
		outputArguments: gnuOutputArguments(['-g1']),
		createParser: defaultAsmParser,
		discoverTools: toolDiscoverer({ demangler: 'c++filt', disassembler: 'objdump' }),
		artifacts: gccArtifacts,
	},
	'clang-cl': {
		executablePattern: /^clang-cl(?:\.exe)?$/i,
		languageIdentifiers: cFamilyLanguageIdentifiers,
		intelSyntax: 'inherent',
		includeFlag: '/I',
		defineFlag: '/D',
		objectFilename: 'output.obj',
		outputArguments: clangClOutputArguments,
		createParser: defaultAsmParser,
		prepareEnvironment: captureWindowsEnvironment,
		demangle: windowsDemangle,
		discoverTools: toolDiscoverer({ demangler: 'llvm-cxxfilt', disassembler: 'llvm-objdump' }),
		artifacts: clangClArtifacts,
	},
	msvc: {
		executablePattern: /^cl\.exe$/i,
		languageIdentifiers: cFamilyLanguageIdentifiers,
		intelSyntax: 'inherent',
		includeFlag: '/I',
		defineFlag: '/D',
		objectFilename: 'output.obj',
		outputArguments: msvcOutputArguments,
		createParser: createMsvcAsmParser,
		prepareEnvironment: captureWindowsEnvironment,
		demangle: windowsDemangle,
		discoverTools: toolDiscoverer({ demangler: 'undname', disassembler: 'dumpbin' }),
		artifacts: msvcArtifacts,
	},
	clang: {
		executablePattern: /^clang(?:\+\+)?(?:-\d+(?:\.\d+)*)?(?:\.exe)?$/i,
		languageIdentifiers: cFamilyLanguageIdentifiers,
		intelSyntax: 'selectable',
		intelArguments: gnuIntelArguments,
		includeFlag: '-I',
		defineFlag: '-D',
		objectFilename: 'output.o',
		outputArguments: gnuOutputArguments(['-gline-tables-only']),
		createParser: defaultAsmParser,
		discoverTools: toolDiscoverer({ demangler: 'llvm-cxxfilt', disassembler: 'llvm-objdump' }),
		artifacts: clangArtifacts,
	},
	'apple-clang': {
		executablePattern: /^clang(?:\+\+)?(?:-\d+(?:\.\d+)*)?(?:\.exe)?$/i,
		languageIdentifiers: cFamilyLanguageIdentifiers,
		intelSyntax: 'selectable',
		intelArguments: gnuIntelArguments,
		includeFlag: '-I',
		defineFlag: '-D',
		objectFilename: 'output.o',
		outputArguments: gnuOutputArguments(['-gline-tables-only']),
		createParser: defaultAsmParser,
		discoverTools: toolDiscoverer({ demangler: 'llvm-cxxfilt', disassembler: 'llvm-objdump' }),
		artifacts: clangArtifacts,
	},
	rust: {
		executablePattern: /^rustc(?:\.exe)?$/i,
		languageIdentifiers: Object.freeze(['rust']),
		intelSyntax: 'selectable',
		intelArguments: rustIntelArguments,
		// rustc has no analogue of a C-style header search path, so unlike the
		// other toolchains this intentionally leaves `includeFlag` unset rather
		// than mapping it to something misleading; `defineFlag` maps CMake
		// compile definitions onto rustc's `--cfg`.
		defineFlag: '--cfg=',
		objectFilename: 'output.o',
		outputArguments: rustOutputArguments,
		stripOwnedArguments: stripRustManagedArguments,
		createParser: defaultAsmParser,
		discoverTools: toolDiscoverer({ demangler: 'rustfilt' }),
		artifacts: rustArtifacts,
	},
} as const satisfies Record<string, ToolchainDefinitionShape>;

/**
 * Aliased to the shape (rather than derived from `typeof toolchainDefinitions`)
 * so that accessing a per-kind-optional field like `prepareEnvironment` doesn't
 * require narrowing a six-member union of distinct literal object types first.
 */
export type ToolchainDefinition = ToolchainDefinitionShape;

export function getToolchainDefinition(kind: ToolchainKind): ToolchainDefinition {
	return toolchainDefinitions[kind];
}

export function detectToolchainDefinition(
	executable: string,
	versionOutput = '',
	platform: NodeJS.Platform = process.platform,
): { kind: ToolchainKind; definition: ToolchainDefinition } | undefined {
	const executableName = path.basename(executable);
	const matches = supportedToolchainKinds.filter(kind =>
		toolchainDefinitions[kind].executablePattern.test(executableName)
	);
	if (matches.includes('apple-clang')) {
		const kind = /apple clang/i.test(versionOutput) || platform === 'darwin'
			? 'apple-clang'
			: 'clang';
		return { kind, definition: toolchainDefinitions[kind] };
	}
	const kind = matches[0];
	return kind ? { kind, definition: toolchainDefinitions[kind] } : undefined;
}

export const supportedToolchainKinds: readonly ToolchainKind[] =
	Object.keys(toolchainDefinitions) as ToolchainKind[];

export const supportedLanguageIdentifiers: ReadonlySet<string> = new Set(
	supportedToolchainKinds.flatMap(kind => toolchainDefinitions[kind].languageIdentifiers),
);

export interface ToolchainProfileOverrides {
	readonly id?: string;
	readonly defaultArguments?: readonly string[];
	readonly environment?: Readonly<Record<string, string>>;
	readonly tools?: Readonly<Record<string, string>>;
}

export function createToolchainProfile(
	kind: ToolchainKind,
	displayName: string,
	executable: string,
	overrides: ToolchainProfileOverrides = {},
): ToolchainProfile {
	const definition = toolchainDefinitions[kind];
	const normalized = path.normalize(executable);
	const detectedTools = definition.discoverTools(normalized);
	return {
		id: overrides.id ?? normalizedExecutableLocalId(normalized),
		displayName,
		kind,
		executable: normalized,
		defaultArguments: overrides.defaultArguments ?? [],
		environment: overrides.environment ?? {},
		tools: Object.freeze({
			...detectedTools,
			...overrides.tools,
		}),
	};
}

export function resolveArtifactAvailability(
	profile: ToolchainProfile,
	kind: ArtifactKind,
): ToolchainArtifactCell {
	const cell: ToolchainArtifactCell = toolchainDefinitions[profile.kind].artifacts[kind];
	if (
		cell.status === 'available'
		&& cell.requiredTool
		&& !profile.tools[cell.requiredTool.name]
	) {
		return {
			status: 'unavailable',
			explanation: `${cell.requiredTool.label} was not detected or configured as the `
				+ `${cell.requiredTool.name} auxiliary tool for ${profile.displayName}.`,
		};
	}
	return cell;
}

export function resolveArtifactOptionAvailability(
	profile: ToolchainProfile,
	kind: ArtifactKind,
	id: ArtifactOptionId,
): ArtifactOptionAvailability {
	const artifact = resolveArtifactAvailability(profile, kind);
	if (artifact.status !== 'available') {
		return artifact;
	}
	if (id === 'demangle') {
		return profile.tools.demangler
			? { status: 'available' }
			: {
				status: 'unavailable',
				explanation: `No demangler was detected or configured for ${profile.displayName}.`,
			};
	}
	if (id === 'intel') {
		const intelSyntax = toolchainDefinitions[profile.kind].intelSyntax;
		if (intelSyntax === 'selectable') {
			return { status: 'available' };
		}
		return intelSyntax === 'inherent'
			? {
				status: 'unavailable',
				explanation: `${profile.displayName} already emits Intel syntax.`,
				reason: 'inherent',
			}
			: {
				status: 'unsupported',
				explanation: `${profile.displayName} does not support selectable Intel syntax.`,
			};
	}
	return { status: 'available' };
}

export function normalizedExecutableLocalId(executable: string): string {
	const normalized = path.resolve(executable);
	return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
