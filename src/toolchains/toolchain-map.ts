import fs from 'fs';
import path from 'path';
import { AppleClangCompiler, ClangCompiler, GccCompiler } from './gcc.js';
import { ClangClCompiler, MsvcCompiler } from './msvc.js';
import type {
	ArtifactKind,
	ArtifactOptionAvailability,
	ArtifactOptionId,
	CompileOptions,
	RawArtifact,
	ToolchainKind,
	ToolchainProfile,
	ToolchainCapabilities,
	IntelSyntaxSupport,
} from '../types/index.js';
import type { ToolchainBackend } from '../toolchains/toolchain-backend.js';
import type { CancellationToken, Uri } from 'vscode';
import { produceAssembly } from '../artifacts/assembly-producer.js';
import type { ToolExecutionGate } from '../tool-execution.js';

type ToolchainBackendConstructor = new(
	profile: ToolchainProfile,
	capabilities: ToolchainCapabilities,
	execution?: ToolExecutionGate,
) => ToolchainBackend;

export type ToolCapabilityStatus = 'available' | 'unavailable' | 'unsupported';

interface ToolchainDefinitionShape {
	readonly Adapter: ToolchainBackendConstructor;
	readonly executablePattern: RegExp;
	readonly languageIdentifiers: readonly string[];
	readonly includeFlag: string;
	readonly defineFlag: string;
	readonly capabilities: ToolchainCapabilities;
	readonly findDemangler: (executable: string) => string | undefined;
	readonly artifacts: Readonly<Record<ArtifactKind, ToolchainArtifactCell>>;
}

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
	}
	| {
		readonly status: 'unavailable' | 'unsupported';
		readonly explanation: string;
	};

const cFamilyLanguageIdentifiers = Object.freeze([
	'c',
	'cpp',
	'objective-c',
	'objective-cpp',
	'cuda',
]);

const artifactCells = {
	assembly: {
		status: 'available',
		producer: produceAssembly,
	},
	'binary-disassembly': {
		status: 'unavailable',
		explanation: 'Binary disassembly is not available because no disassembler producer is configured.',
	},
	'llvm-ir': {
		status: 'unsupported',
		explanation: 'This toolchain has no LLVM IR producer.',
	},
	'optimization-remarks': {
		status: 'unsupported',
		explanation: 'This toolchain has no optimization-remarks producer.',
	},
} as const satisfies Readonly<Record<ArtifactKind, ToolchainArtifactCell>>;

const clangArtifactCells = {
	...artifactCells,
	'llvm-ir': {
		status: 'unavailable',
		explanation: 'LLVM IR production is not available in this release.',
	},
	'optimization-remarks': {
		status: 'unavailable',
		explanation: 'Optimization-remarks production is not available in this release.',
	},
} as const satisfies Readonly<Record<ArtifactKind, ToolchainArtifactCell>>;

const gccArtifactCells = {
	...artifactCells,
	'optimization-remarks': {
		status: 'unavailable',
		explanation: 'Optimization-remarks production is not available in this release.',
	},
} as const satisfies Readonly<Record<ArtifactKind, ToolchainArtifactCell>>;

const existingFile = (candidate: string): string | undefined =>
	fs.existsSync(candidate) ? candidate : undefined;
const sibling = (executable: string, name: string): string =>
	path.join(path.dirname(executable), name);

export const toolchainDefinitions = {
	gcc: {
		Adapter: GccCompiler,
		executablePattern: /^(?:gcc|g\+\+)(?:-\d+(?:\.\d+)*)?(?:\.exe)?$/i,
		languageIdentifiers: cFamilyLanguageIdentifiers,
		includeFlag: '-I',
		defineFlag: '-D',
		capabilities: {
			demangle: true,
			intelSyntax: 'selectable',
			libraryCodeFilter: true,
		},
		findDemangler: executable => existingFile(executable.replace(
			/(?:gcc|g\+\+)(?:-\d+(?:\.\d+)*)?(?:\.exe)?$/i,
			process.platform === 'win32' ? 'c++filt.exe' : 'c++filt',
		)),
		artifacts: gccArtifactCells,
	},
	'clang-cl': {
		Adapter: ClangClCompiler,
		executablePattern: /^clang-cl(?:\.exe)?$/i,
		languageIdentifiers: cFamilyLanguageIdentifiers,
		includeFlag: '/I',
		defineFlag: '/D',
		capabilities: {
			demangle: true,
			intelSyntax: 'inherent',
			libraryCodeFilter: true,
		},
		findDemangler: executable => existingFile(sibling(executable, 'llvm-cxxfilt.exe')),
		artifacts: clangArtifactCells,
	},
	msvc: {
		Adapter: MsvcCompiler,
		executablePattern: /^cl\.exe$/i,
		languageIdentifiers: cFamilyLanguageIdentifiers,
		includeFlag: '/I',
		defineFlag: '/D',
		capabilities: {
			demangle: true,
			intelSyntax: 'inherent',
			libraryCodeFilter: true,
		},
		findDemangler: executable => existingFile(executable.replace(/cl\.exe$/i, 'undname.exe')),
		artifacts: artifactCells,
	},
	clang: {
		Adapter: ClangCompiler,
		executablePattern: /^clang(?:\+\+)?(?:-\d+(?:\.\d+)*)?(?:\.exe)?$/i,
		languageIdentifiers: cFamilyLanguageIdentifiers,
		includeFlag: '-I',
		defineFlag: '-D',
		capabilities: {
			demangle: true,
			intelSyntax: 'selectable',
			libraryCodeFilter: true,
		},
		findDemangler: executable => existingFile(sibling(
			executable,
			process.platform === 'win32' ? 'llvm-cxxfilt.exe' : 'llvm-cxxfilt',
		)),
		artifacts: clangArtifactCells,
	},
	'apple-clang': {
		Adapter: AppleClangCompiler,
		executablePattern: /^clang(?:\+\+)?(?:-\d+(?:\.\d+)*)?(?:\.exe)?$/i,
		languageIdentifiers: cFamilyLanguageIdentifiers,
		includeFlag: '-I',
		defineFlag: '-D',
		capabilities: {
			demangle: true,
			intelSyntax: 'selectable',
			libraryCodeFilter: true,
		},
		findDemangler: executable => existingFile(sibling(
			executable,
			process.platform === 'win32' ? 'llvm-cxxfilt.exe' : 'llvm-cxxfilt',
		)),
		artifacts: clangArtifactCells,
	},
} as const satisfies Record<string, ToolchainDefinitionShape>;

export type ToolchainDefinition = (typeof toolchainDefinitions)[ToolchainKind];

export function getToolchainDefinition(type: string): ToolchainDefinition | undefined {
	return Object.hasOwn(toolchainDefinitions, type)
		? toolchainDefinitions[type as ToolchainKind]
		: undefined;
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
	const detectedDemangler = definition.findDemangler(normalized);
	return {
		id: overrides.id ?? normalizedExecutableLocalId(normalized),
		displayName,
		kind,
		executable: normalized,
		defaultArguments: overrides.defaultArguments ?? [],
		environment: overrides.environment ?? {},
		tools: overrides.tools ?? Object.freeze({
			...(detectedDemangler ? { demangler: detectedDemangler } : {}),
		}),
	};
}

export interface ResolvedToolchainCapabilities {
	readonly demangle: ToolCapabilityStatus;
	readonly intelSyntax: IntelSyntaxSupport;
	readonly libraryCodeFilter: 'available' | 'unsupported';
}

export function resolveToolchainCapabilities(profile: ToolchainProfile): ResolvedToolchainCapabilities {
	const capabilities = toolchainDefinitions[profile.kind].capabilities;
	return {
		demangle: capabilities.demangle
			? profile.tools.demangler ? 'available' : 'unavailable'
			: 'unsupported',
		intelSyntax: capabilities.intelSyntax,
		libraryCodeFilter: capabilities.libraryCodeFilter ? 'available' : 'unsupported',
	};
}

export function resolveArtifactAvailability(
	profile: ToolchainProfile,
	kind: ArtifactKind,
): ToolchainArtifactCell {
	return toolchainDefinitions[profile.kind].artifacts[kind];
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
		const status = resolveToolchainCapabilities(profile).demangle;
		return status === 'available'
			? { status }
			: {
				status,
				explanation: status === 'unsupported'
					? `${profile.displayName} does not support symbol demangling.`
					: `No demangler was detected or configured for ${profile.displayName}.`,
			};
	}
	if (id === 'intel') {
		const status = resolveToolchainCapabilities(profile).intelSyntax;
		return status === 'selectable'
			? { status: 'available' }
			: {
				status: status === 'unsupported' ? 'unsupported' : 'unavailable',
				explanation: status === 'inherent'
					? `${profile.displayName} already emits Intel syntax.`
					: `${profile.displayName} does not support selectable Intel syntax.`,
			};
	}
	if (id === 'libraryCode' && !toolchainDefinitions[profile.kind].capabilities.libraryCodeFilter) {
		return {
			status: 'unsupported',
			explanation: `${profile.displayName} does not support library-code filtering.`,
		};
	}
	return { status: 'available' };
}

export function normalizedExecutableLocalId(executable: string): string {
	const normalized = path.resolve(executable);
	return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
