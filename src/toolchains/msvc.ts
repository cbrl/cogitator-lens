import fs from 'fs';
import path from 'path';
import type { CancellationToken } from 'vscode';
import { VcAsmParser } from '../vendor/lib/parsers/asm-parser-vc.js';
import { noopPropertyGetter } from '../vendor/compiler-props.js';
import type { ToolchainProfile } from '../types/index.js';
import * as exec from '../exec.js';
import { ExecError } from '../exec.js';
import { artifactProducer } from '../artifacts/core/compiler-output-producer.js';
import { binaryDisassemblyProducer, normalizeDisassemblySourcePaths } from '../artifacts/binary-disassembly/binary-disassembly-producer.js';
import { parseMsvcSourceDependencies } from '../compilation/artifact-inputs.js';
import { MsvcAssemblyCfgParser } from '../artifacts/control-flow-graph/parsers/assembly-dialects.js';
import { artifactCells, assemblyCell, assemblyControlFlowGraphOutput, binaryCell, outputArtifactCell, toolDiscoverer, type ToolchainDefinition } from './toolchain-contracts.js';
import type { BinaryDisassembler, DependencyCollectionSpec } from './toolchain-backend.js';
import { cFamilyLanguageIdentifiers, stripCompilerManagedArguments } from './c-family.js';
import { parseParenthesizedDiagnostics } from './msvc/diagnostics.js';

export const visualStudioDiscoveryArguments = [
	'-latest',
	'-prerelease',
	'-products',
	'*',
	'-requires',
	'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
	'-property',
	'installationPath',
] as const;

/** Returns vcvarsall.bat locations implied by a compiler path within a Visual Studio install. */
export function visualStudioEnvironmentCandidates(executable: string): readonly string[] {
	const candidates: string[] = [];
	let directory = path.win32.dirname(executable);
	while (true) {
		if (path.win32.basename(directory).toLowerCase() === 'vc') {
			candidates.push(path.win32.join(directory, 'Auxiliary', 'Build', 'vcvarsall.bat'));
		}
		const parent = path.win32.dirname(directory);
		if (parent === directory) {
			return candidates;
		}
		directory = parent;
	}
}

/** Creates the MSVC-specific parser used for textual assembly listings. */
export function createMsvcAsmParser(): VcAsmParser {
	return new VcAsmParser(noopPropertyGetter);
}

/** Builds CL.exe arguments for line-mapped assembly or an object file. */
export function msvcOutputArguments(target: 'assembly' | 'object', outputFile: string): readonly string[] {
	return target === 'assembly'
		? ['/nologo', '/c', '/FAcs', `/Fa${outputFile}`, `/Fo${outputFile}.obj`, `/Fd${outputFile}.pdb`]
		: ['/nologo', '/c', '/Z7', `/Fo${outputFile}`];
}

/** Builds clang-cl output arguments while retaining debug information required for source mapping. */
export function clangClOutputArguments(target: 'assembly' | 'object', outputFile: string): readonly string[] {
	return target === 'assembly'
		? ['/Z7', ...msvcOutputArguments('assembly', outputFile)]
		: msvcOutputArguments('object', outputFile);
}

const environmentCache = new Map<string, Promise<NodeJS.ProcessEnv>>();

/** Loads and caches the Visual Studio build environment, then layers invocation overrides over it. */
export async function captureWindowsEnvironment(
	profile: ToolchainProfile,
	environment: NodeJS.ProcessEnv,
	cancellationToken: CancellationToken,
): Promise<NodeJS.ProcessEnv> {
	const architecture = vcvarsArchitecture(profile.executable);
	const cacheKey = `${path.normalize(profile.executable).toLowerCase()}\0${architecture}`;
	let environmentPromise = environmentCache.get(cacheKey);
	if (!environmentPromise) {
		environmentPromise = captureVisualStudioEnvironment(
			{ ...process.env },
			profile.executable,
			architecture,
			cancellationToken,
		);
		environmentCache.set(cacheKey, environmentPromise);
		void environmentPromise.catch(() => {
			if (environmentCache.get(cacheKey) === environmentPromise) {
				environmentCache.delete(cacheKey);
			}
		});
	}
	const visualStudioEnvironment = { ...(await environmentPromise) };
	for (const [name, value] of Object.entries(environment)) {
		if (value !== process.env[name]) {
			visualStudioEnvironment[name] = value;
		}
	}
	return visualStudioEnvironment;
}

async function captureVisualStudioEnvironment(
	baseEnvironment: NodeJS.ProcessEnv,
	executable: string,
	vcvarsArchitectureValue: string,
	cancellationToken: CancellationToken,
): Promise<NodeJS.ProcessEnv> {
	const vcvarsScript = await findVisualStudioEnvironmentScript(executable, baseEnvironment, cancellationToken);

	const captureCommand = `call "${vcvarsScript}" ${vcvarsArchitectureValue} >nul && set`;
	const result = await exec.execute('cmd.exe', ['/d', '/s', '/c', captureCommand], {
		env: baseEnvironment,
		cancellationToken,
		windowsVerbatimArguments: true,
	});
	if (result.returnCode !== 0) {
		throw new Error(`Visual Studio environment setup failed with code ${result.returnCode}: ${result.stderr}`);
	}

	const captured: NodeJS.ProcessEnv = { ...baseEnvironment };
	for (const line of result.stdout.split(/\r?\n/)) {
		const separator = line.indexOf('=');
		if (separator > 0) {
			captured[line.slice(0, separator)] = line.slice(separator + 1);
		}
	}

	return captured;
}

async function findVisualStudioEnvironmentScript(
	executable: string,
	baseEnvironment: NodeJS.ProcessEnv,
	cancellationToken: CancellationToken,
): Promise<string> {
	const programFilesX86 = baseEnvironment['ProgramFiles(x86)'] ?? baseEnvironment.PROGRAMFILES_X86;
	if (programFilesX86) {
		const vswhere = path.join(programFilesX86, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
		if (fs.existsSync(vswhere)) {
			try {
				const result = await exec.execute(vswhere, visualStudioDiscoveryArguments, {
					env: baseEnvironment,
					cancellationToken,
				});
				if (result.returnCode === 0) {
					const installationPath = result.stdout
						.split(/\r?\n/)
						.find((line) => line.trim())
						?.trim();
					if (installationPath) {
						const discovered = path.join(installationPath, 'VC', 'Auxiliary', 'Build', 'vcvarsall.bat');
						if (fs.existsSync(discovered)) {
							return discovered;
						}
					}
				}
			} catch (error) {
				if (error instanceof ExecError && error.kind === 'cancelled') {
					throw error;
				}
			}
		}
	}

	for (const candidate of visualStudioEnvironmentCandidates(executable)) {
		if (fs.existsSync(candidate)) {
			return candidate;
		}
	}
	throw new Error(`Visual Studio environment script was not found through vswhere or relative to ${executable}`);
}

function vcvarsArchitecture(executable: string): string {
	const compilerDirectory = path.dirname(executable);
	const target = normalizeArchitecture(path.basename(compilerDirectory));
	const hostMatch = /^Host(.+)$/i.exec(path.basename(path.dirname(compilerDirectory)));
	if (target && hostMatch) {
		const host = normalizeArchitecture(hostMatch[1]);
		if (host) {
			return host === target ? target : `${host}_${target}`;
		}
	}

	const host = normalizeArchitecture(process.arch);
	if (!host) {
		throw new Error(`Unsupported host architecture: ${process.arch}`);
	}
	return host;
}

function normalizeArchitecture(value: string): string | undefined {
	switch (value.toLowerCase()) {
		case 'x64':
		case 'amd64':
			return 'amd64';
		case 'x86':
		case 'ia32':
			return 'x86';
		case 'arm':
			return 'arm';
		case 'arm64':
			return 'arm64';
		default:
			return undefined;
	}
}

export const dumpbin: BinaryDisassembler = Object.freeze({
	tool: 'disassembler',
	arguments: (objectFile: string) => ['/nologo', '/disasm:bytes', '/linenumbers', objectFile],
	normalizeOutput: normalizeDumpbinOutput,
});

/** Converts dumpbin's COFF listing into the GNU/LLVM objdump shape used by the shared parser. */
export function normalizeDumpbinOutput(output: string): string {
	const normalized: string[] = [];
	let pendingSymbol: string | undefined;
	let pendingSource: string | undefined;
	for (const originalLine of output.split(/\r?\n/)) {
		const line = originalLine.trimEnd();
		const instruction = /^\s*([0-9a-f]+):\s*((?:[0-9a-f]{2}\s+)+)(.*)$/i.exec(line);
		if (instruction) {
			const address = instruction[1].toLowerCase();
			if (pendingSymbol) { normalized.push(`${address} <${pendingSymbol}>:`); pendingSymbol = undefined; }
			if (pendingSource) { normalized.push(pendingSource); pendingSource = undefined; }
			normalized.push(`${address}: ${instruction[2].toLowerCase()}${instruction[3]}`);
			continue;
		}
		const addressAndSymbol = /^\s*([0-9a-f]+)\s+<?([^<>:]+)>?:\s*$/i.exec(line);
		if (addressAndSymbol) {
			normalized.push(`${addressAndSymbol[1].toLowerCase()} <${addressAndSymbol[2].trim()}>:`);
			pendingSymbol = undefined; pendingSource = undefined; continue;
		}
		const symbol = /^\s*([?$@A-Z_a-z][^:]*):\s*$/.exec(line);
		if (symbol) { const heading = symbol[1].trim(); pendingSymbol = /^(\S+)\s+\(/.exec(heading)?.[1] ?? heading; continue; }
		const source = /^\s*(.+\.[A-Za-z0-9_+-]+)\((\d+)\)\s*$/.exec(line);
		if (source) {
			const normalizedSource = normalizeDisassemblySourcePaths(`${source[1]}:${source[2]}`);
			if (pendingSymbol) {pendingSource = normalizedSource;} else {normalized.push(normalizedSource);}
		}
	}
	const symbolByAddress = new Map<string, string>();
	const addressBySymbol = new Map<string, string>();
	for (const line of normalized) {
		const label = /^([0-9a-f]+) <(.+)>:$/.exec(line);
		if (label) { symbolByAddress.set(canonicalAddress(label[1]), label[2]); addressBySymbol.set(label[2], label[1]); }
	}
	return normalized.map((line) => {
		const numericBranch = /\b(?:call|j[a-z]+)\s+([0-9a-f]+)$/i.exec(line);
		const numericSymbol = numericBranch ? symbolByAddress.get(canonicalAddress(numericBranch[1])) : undefined;
		if (numericBranch && numericSymbol) {return `${line} <${numericSymbol}>`;}
		const symbolicBranch = /\b(?:call|j[a-z]+)\s+(\S+)$/i.exec(line);
		const address = symbolicBranch ? addressBySymbol.get(symbolicBranch[1]) : undefined;
		return symbolicBranch && address ? line.replace(symbolicBranch[1], `${address} <${symbolicBranch[1]}>`) : line;
	}).join('\n');
}

/** Normalizes hexadecimal addresses so branch targets match labels with different padding. */
function canonicalAddress(address: string): string { return address.toLowerCase().replace(/^0+/, '') || '0'; }

export const msvcDependencyCollection: DependencyCollectionSpec = Object.freeze({
	outputFilename: 'dependencies.json',
	arguments: (outputFile: string, temporaryDirectory: string) => ['/c', '/sourceDependencies', outputFile, `/Fo${path.join(temporaryDirectory, 'dependencies.obj')}`],
	parse: parseMsvcSourceDependencies,
});
export const msvcPreprocessedSourceProducer = artifactProducer('preprocessed-source', { output: 'stdout', arguments: () => ['/E'] });

export const msvc: ToolchainDefinition = {
	executablePattern: /^cl\.exe$/i,
	parseDiagnostics: parseParenthesizedDiagnostics,
	languageIdentifiers: cFamilyLanguageIdentifiers,
	intelSyntax: 'inherent', includeFlag: '/I', defineFlag: '/D', objectFilename: 'output.obj',
	outputArguments: msvcOutputArguments, stripOwnedArguments: stripCompilerManagedArguments,
	dependencyCollection: msvcDependencyCollection, createParser: createMsvcAsmParser,
	createCfgParser: () => new MsvcAssemblyCfgParser(), prepareEnvironment: captureWindowsEnvironment,
	discoverTools: (executable) => {
		const tools = toolDiscoverer({ demangler: 'undname', disassembler: 'dumpbin' })(executable);
		return Object.freeze({
			...tools,
			...(tools.demangler
				? { demangler: Object.freeze({ ...tools.demangler, inputMode: 'file-argument' as const }) }
				: {}),
		});
	},
	artifacts: artifactCells({
		assembly: assemblyCell,
		'binary-disassembly': binaryCell('dumpbin', binaryDisassemblyProducer(dumpbin)),
		'preprocessed-source': { status: 'available', producer: msvcPreprocessedSourceProducer },
		'control-flow-graph': outputArtifactCell([assemblyControlFlowGraphOutput]),
	}),
};
