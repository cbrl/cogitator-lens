import fs from 'fs';
import path from 'path';
import type { ToolchainProfile } from '../types/index.js';
import { canonicalLocalPath } from '../file-identity.js';
import { DotNetPdbParser } from '../vendor/lib/parsers/pdb-parser-dotnet.js';
import { dotNetSourceMappingData } from '../artifacts/dotnet/dotnet-source-mapping.js';
import { renderDotNetIl } from '../artifacts/dotnet/dotnet-il-renderer.js';
import { readBoundedArtifactBuffer } from './toolchain-backend.js';
import {
	executableOnPath,
	type ArtifactProducer,
	type ToolchainDefinition,
	withoutOwnedArguments,
} from './toolchain-contracts.js';
import { parseParenthesizedDiagnostics } from './msvc/diagnostics.js';

export const dotNetIlProducer: ArtifactProducer = (backend, source, options, cancellationToken) =>
	backend.produceWithTool(
		source,
		options,
		{
			workspaceFiles: { assembly: 'output.dll', pdb: 'output.pdb' },
			compilerArguments: (files, providerArguments) =>
				dotNetCsharpArguments(backend.profile, files.assembly, providerArguments),
			tool: 'ildasm',
			toolArguments: (files) => dotNetIlDasmArguments(files.assembly),
			producerData: async (files) => {
				try {
					const [assembly, pdb] = await Promise.all([
						readBoundedArtifactBuffer(files.assembly),
						readBoundedArtifactBuffer(files.pdb),
					]);
					return dotNetSourceMappingData(new DotNetPdbParser(assembly, pdb).parse());
				} catch {
					return undefined;
				}
			},
		},
		cancellationToken,
	);

/**
 * Build the direct Roslyn invocation used by Compiler Explorer's .NET backend.
 * Running csc.dll through the configured dotnet host keeps standalone source
 * artifacts independent from an on-disk project file.
 */
export function dotNetCsharpArguments(
	profile: ToolchainProfile,
	assemblyFile: string,
	_providerArguments: readonly string[],
): readonly string[] {
	const compiler = profile.tools.compiler?.executable;
	if (!compiler) {
		throw new Error(
			`Roslyn csc.dll was not detected or configured as the compiler auxiliary tool for ${profile.displayName}.`,
		);
	}
	const references = dotNetReferenceAssemblies(compiler);
	if (references.length === 0) {
		throw new Error(`No .NET reference assemblies were found for ${compiler}.`);
	}
	return [
		compiler,
		'-nologo',
		'-target:library',
		'-filealign:512',
		'-unsafe+',
		'-checked-',
		'-fullpaths',
		'-nostdlib+',
		'-errorreport:prompt',
		'-warn:9',
		'-highentropyva+',
		'-nullable:enable',
		'-debug:portable',
		'-optimize+',
		'-warnaserror-',
		'-utf8output',
		'-deterministic+',
		...references.map((reference) => `-reference:${reference}`),
		`-out:${assemblyFile}`,
	];
}

/** Compiler Explorer consumes ILDasm's UTF-8 stdout; text mode also avoids the Windows GUI. */
export function dotNetIlDasmArguments(assemblyFile: string): readonly string[] {
	return [assemblyFile, '-utf8', '-text', '-nobar', '-linenum'];
}

/** Removes Roslyn output settings and the source path owned by .NET artifact production. */
export function stripDotNetManagedArguments(
	args: readonly string[],
	sourceFile: string,
	workingDirectory: string,
): readonly string[] {
	return withoutOwnedArguments(args, sourceFile, workingDirectory, {
		withValue: [/^[-/](?:out|target|debug|pdb|refout|doc)$/i],
		standalone: [/^[-/](?:out|target|debug|pdb|refout|doc)(?::|=)|^[-/]nologo$/i],
	});
}

/** Discovers the Roslyn compiler and ILDasm associated with a configured dotnet host. */
export function discoverDotNetTools(
	executable: string,
): Readonly<Record<string, import('../types/index.js').AuxiliaryTool>> {
	const compiler = discoverRoslynCompiler(executable);
	const ildasm = discoverIlDasm(executable);
	return Object.freeze({
		...(compiler ? { compiler: Object.freeze({ executable: compiler, inputMode: 'stdin' as const }) } : {}),
		...(ildasm ? { ildasm: Object.freeze({ executable: ildasm, inputMode: 'stdin' as const }) } : {}),
	});
}

function discoverRoslynCompiler(executable: string): string | undefined {
	let roots = executableRoots(executable);

	const systemRoot = discoverSystemDotNetRoot();
	if (systemRoot) {
		roots = [...roots, systemRoot];
	}

	for (const root of roots) {
		const sdkRoot = path.join(root, 'sdk');
		for (const version of childDirectories(sdkRoot).sort(compareVersionsDescending)) {
			const candidate = path.join(sdkRoot, version, 'Roslyn', 'bincore', 'csc.dll');
			if (fs.existsSync(candidate)) {
				return candidate;
			}
		}
	}
	return undefined;
}

function discoverIlDasm(executable: string): string | undefined {
	const executableName = process.platform === 'win32' ? 'ildasm.exe' : 'ildasm';
	for (const root of executableRoots(executable)) {
		const sibling = path.join(root, executableName);
		if (fs.existsSync(sibling)) {
			return sibling;
		}
	}
	const onPath = executableOnPath(executableName);
	if (onPath) {
		return onPath;
	}
	return process.platform === 'win32' ? discoverWindowsSdkIlDasm() : undefined;
}

function dotNetReferenceAssemblies(compiler: string): readonly string[] {
	const compilerDirectory = path.dirname(compiler);
	const sdkVersion = path.basename(path.resolve(compilerDirectory, '..', '..'));
	const sdkMajor = /^\d+/.exec(sdkVersion)?.[0];
	const dotNetRoot = path.resolve(compilerDirectory, '..', '..', '..', '..');
	const packsRoot = path.join(dotNetRoot, 'packs', 'Microsoft.NETCore.App.Ref');
	const packVersions = childDirectories(packsRoot).sort(compareVersionsDescending);
	const matchingVersions = sdkMajor
		? [...packVersions.filter((version) => version.startsWith(`${sdkMajor}.`)), ...packVersions]
		: packVersions;
	for (const version of [...new Set(matchingVersions)]) {
		const refRoot = path.join(packsRoot, version, 'ref');
		const frameworks = childDirectories(refRoot).sort(compareFrameworksDescending);
		const preferred = sdkMajor ? `net${sdkMajor}.0` : undefined;
		const framework = (preferred && frameworks.includes(preferred) ? preferred : undefined) ?? frameworks[0];
		if (!framework) {
			continue;
		}
		const directory = path.join(refRoot, framework);
		const references = fs
			.readdirSync(directory, { withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.dll'))
			.map((entry) => path.join(directory, entry.name))
			.sort((left, right) => left.localeCompare(right));
		if (references.length > 0) {
			return references;
		}
	}
	return [];
}

function executableRoots(executable: string): readonly string[] {
	const roots = [path.dirname(path.resolve(executable))];
	// Preserve the configured path when it names a complete installation, but
	// also support launchers symlinked from outside the installation root.
	roots.push(path.dirname(canonicalLocalPath(executable)));
	return [...new Set(roots)];
}

function discoverSystemDotNetRoot(): string | undefined {
	const programFiles = process.env['ProgramW6432'] ?? process.env.PROGRAMFILES;
	if (!programFiles) {
		return undefined;
	}
	const dotNetRoot = path.join(programFiles, 'dotnet');
	if (fs.existsSync(dotNetRoot)) {
		return dotNetRoot;
	}

	const executableName = process.platform === 'win32' ? 'dotnet.exe' : 'dotnet';
	const pathExe = executableOnPath(executableName);
	if (pathExe) {
		return path.dirname(path.resolve(pathExe));
	}

	return undefined;
}

function discoverWindowsSdkIlDasm(): string | undefined {
	const programFilesX86 = process.env['ProgramFiles(x86)'] ?? process.env.PROGRAMFILES_X86;
	if (!programFilesX86) {
		return undefined;
	}
	const windowsSdkRoot = path.join(programFilesX86, 'Microsoft SDKs', 'Windows');
	for (const version of childDirectories(windowsSdkRoot).sort(compareVersionsDescending)) {
		const bin = path.join(windowsSdkRoot, version, 'bin');
		for (const tools of childDirectories(bin).sort().reverse()) {
			if (!/^NETFX .* Tools$/i.test(tools)) {
				continue;
			}
			for (const relative of [path.join(tools, 'x64', 'ildasm.exe'), path.join(tools, 'ildasm.exe')]) {
				const candidate = path.join(bin, relative);
				if (fs.existsSync(candidate)) {
					return candidate;
				}
			}
		}
	}
	return undefined;
}

function childDirectories(directory: string): string[] {
	try {
		return fs
			.readdirSync(directory, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
	} catch {
		return [];
	}
}

function compareVersionsDescending(left: string, right: string): number {
	const leftParts = left.match(/\d+/g)?.map(Number) ?? [];
	const rightParts = right.match(/\d+/g)?.map(Number) ?? [];
	for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index++) {
		const difference = (rightParts[index] ?? 0) - (leftParts[index] ?? 0);
		if (difference !== 0) {
			return difference;
		}
	}
	return right.localeCompare(left);
}

function compareFrameworksDescending(left: string, right: string): number {
	return compareVersionsDescending(left.replace(/^net/i, ''), right.replace(/^net/i, ''));
}

export const dotnet: ToolchainDefinition = {
	executablePattern: /^dotnet(?:\.exe)?$/i,
	parseDiagnostics: parseParenthesizedDiagnostics,
	languageIdentifiers: Object.freeze(['csharp']),
	stripOwnedArguments: stripDotNetManagedArguments,
	discoverTools: discoverDotNetTools,
	artifacts: {
		assembly: {
			producer: dotNetIlProducer,
			renderer: renderDotNetIl,
			listingSyntax: 'dotnet-il',
			requiredTools: [
				{ name: 'compiler', label: 'Roslyn csc.dll' },
				{ name: 'ildasm', label: '.NET IL disassembler (ildasm)' },
			],
		},
	},
};
