import fs from 'fs';
import path from 'path';
import { AppleClangCompiler, ClangCompiler, GccCompiler } from './gcc.js';
import { ClangClCompiler, MsvcCompiler } from './msvc.js';
import type {
	ToolchainKind,
	ToolchainProfile,
	ToolchainCapabilities,
	IntelSyntaxSupport,
} from '../types/index.js';
import type { ToolchainBackend } from '../toolchains/toolchain-backend.js';

type ToolchainBackendConstructor = new(
	profile: ToolchainProfile,
	capabilities: ToolchainCapabilities,
) => ToolchainBackend;

export type ToolCapabilityStatus = 'available' | 'unavailable' | 'unsupported';

interface ToolchainDefinitionShape {
	readonly Adapter: ToolchainBackendConstructor;
	readonly executablePattern: RegExp;
	readonly includeFlag: string;
	readonly defineFlag: string;
	readonly capabilities: ToolchainCapabilities;
	readonly findDemangler: (executable: string) => string | undefined;
}

const existingFile = (candidate: string): string | undefined =>
	fs.existsSync(candidate) ? candidate : undefined;
const sibling = (executable: string, name: string): string =>
	path.join(path.dirname(executable), name);

export const toolchainDefinitions = {
	gcc: {
		Adapter: GccCompiler,
		executablePattern: /^(?:gcc|g\+\+)(?:-\d+(?:\.\d+)*)?(?:\.exe)?$/i,
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
	},
	'clang-cl': {
		Adapter: ClangClCompiler,
		executablePattern: /^clang-cl(?:\.exe)?$/i,
		includeFlag: '/I',
		defineFlag: '/D',
		capabilities: {
			demangle: true,
			intelSyntax: 'inherent',
			libraryCodeFilter: true,
		},
		findDemangler: executable => existingFile(sibling(executable, 'llvm-cxxfilt.exe')),
	},
	msvc: {
		Adapter: MsvcCompiler,
		executablePattern: /^cl\.exe$/i,
		includeFlag: '/I',
		defineFlag: '/D',
		capabilities: {
			demangle: true,
			intelSyntax: 'inherent',
			libraryCodeFilter: true,
		},
		findDemangler: executable => existingFile(executable.replace(/cl\.exe$/i, 'undname.exe')),
	},
	clang: {
		Adapter: ClangCompiler,
		executablePattern: /^clang(?:\+\+)?(?:-\d+(?:\.\d+)*)?(?:\.exe)?$/i,
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
	},
	'apple-clang': {
		Adapter: AppleClangCompiler,
		executablePattern: /^clang(?:\+\+)?(?:-\d+(?:\.\d+)*)?(?:\.exe)?$/i,
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
		demangle: !capabilities.demangle
			? 'unsupported'
			: profile.tools.demangler ? 'available' : 'unavailable',
		intelSyntax: capabilities.intelSyntax,
		libraryCodeFilter: capabilities.libraryCodeFilter ? 'available' : 'unsupported',
	};
}

export function normalizedExecutableLocalId(executable: string): string {
	const normalized = path.resolve(executable);
	return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
