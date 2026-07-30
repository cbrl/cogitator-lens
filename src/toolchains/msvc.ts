import fs from 'fs';
import path from 'path';
import type { CancellationToken } from 'vscode';
import { VcAsmParser } from '../vendor/lib/parsers/asm-parser-vc.js';
import { noopPropertyGetter } from '../vendor/compiler-props.js';
import { withTemporaryDirectory } from '../temporary-directory.js';
import { demangleViaStdin, ToolExitError } from './toolchain-backend.js';
import type { ToolchainProfile } from '../types/index.js';
import * as exec from '../exec.js';
import { ExecError } from '../exec.js';

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

export function createMsvcAsmParser(): VcAsmParser {
	return new VcAsmParser(noopPropertyGetter);
}

export function msvcOutputArguments(target: 'assembly' | 'object', outputFile: string): readonly string[] {
	return target === 'assembly'
		? ['/nologo', '/c', '/FAcs', `/Fa${outputFile}`, `/Fo${outputFile}.obj`, `/Fd${outputFile}.pdb`]
		: ['/nologo', '/c', '/Z7', `/Fo${outputFile}`];
}

export function clangClOutputArguments(target: 'assembly' | 'object', outputFile: string): readonly string[] {
	return target === 'assembly'
		? ['/Z7', ...msvcOutputArguments('assembly', outputFile)]
		: msvcOutputArguments('object', outputFile);
}

const environmentCache = new Map<string, Promise<NodeJS.ProcessEnv>>();

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
	const visualStudioEnvironment = { ...await environmentPromise };
	for (const [name, value] of Object.entries(environment)) {
		if (value !== process.env[name]) {
			visualStudioEnvironment[name] = value;
		}
	}
	return visualStudioEnvironment;
}

/**
 * MSVC's own demangler (undname) only reads from a file, unlike every other
 * supported toolchain's demangler, which reads assembly from stdin. Tools
 * configured under the `demangler` slot that aren't literally undname (e.g.
 * clang-cl's llvm-cxxfilt) still go through the shared stdin path.
 */
export async function windowsDemangle(
	rawAssembly: string,
	demanglerTool: string,
	environment: NodeJS.ProcessEnv,
	workingDirectory: string,
	cancellationToken: CancellationToken,
): Promise<string> {
	if (!/^undname(?:\.exe)?$/i.test(path.basename(demanglerTool))) {
		return demangleViaStdin(rawAssembly, demanglerTool, environment, workingDirectory, cancellationToken);
	}

	return withTemporaryDirectory('coglens-undname-', async temporaryDirectory => {
		const inputFile = path.join(temporaryDirectory, 'assembly.txt');
		await fs.promises.writeFile(inputFile, rawAssembly, 'utf8');
		const result = await exec.execute(demanglerTool, [inputFile], {
			cwd: workingDirectory,
			env: environment,
			cancellationToken,
		});
		if (result.returnCode !== 0) {
			throw new ToolExitError(
				`Demangler exited with code ${result.returnCode}`,
				result.returnCode,
				result.stdout,
				result.stderr,
			);
		}
		return result.stdout;
	});
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
					const installationPath = result.stdout.split(/\r?\n/).find(line => line.trim())?.trim();
					if (installationPath) {
						const discovered = path.join(
							installationPath,
							'VC',
							'Auxiliary',
							'Build',
							'vcvarsall.bat',
						);
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
	throw new Error(
		`Visual Studio environment script was not found through vswhere or relative to ${executable}`,
	);
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
