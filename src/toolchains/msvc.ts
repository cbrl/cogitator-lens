import fs from 'fs';
import path from 'path';
import { ToolchainBackend, ToolExitError } from '../toolchains/toolchain-backend.js';
import type { CancellationToken } from 'vscode';
import { VcAsmParser } from '../parsers/asm-parser-vc.js';
import { withTemporaryDirectory } from '../temporary-directory.js';
import type {
	ToolchainProfile,
	ToolchainCapabilities,
	ProductionOptions,
} from '../types/index.js';
import {
	ExecError,
	ToolExecutionGate,
	type ExecResult,
} from '../tool-execution.js';

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

abstract class WindowsToolchainBackend extends ToolchainBackend {
	private static readonly environmentCache = new Map<string, Promise<NodeJS.ProcessEnv>>();

	protected override prepareArguments(outputFile: string): readonly string[] {
		return ['/nologo', '/c', '/FAcs', `/Fa${outputFile}`, `/Fo${outputFile}.obj`, `/Fd${outputFile}.pdb`];
	}

	protected override async runCompiler(
		args: readonly string[],
		environment: NodeJS.ProcessEnv,
		workingDirectory: string,
		cancellationToken: CancellationToken,
	): Promise<ExecResult> {
		const architecture = vcvarsArchitecture(this.profile.executable);
		const cacheKey = `${path.normalize(this.profile.executable).toLowerCase()}\0${architecture}`;
		let environmentPromise = WindowsToolchainBackend.environmentCache.get(cacheKey);
		if (!environmentPromise) {
			environmentPromise = this.captureVisualStudioEnvironment(
				{ ...process.env },
				architecture,
				cancellationToken,
			);
			WindowsToolchainBackend.environmentCache.set(cacheKey, environmentPromise);
			void environmentPromise.catch(() => {
				if (WindowsToolchainBackend.environmentCache.get(cacheKey) === environmentPromise) {
					WindowsToolchainBackend.environmentCache.delete(cacheKey);
				}
			});
		}
		const visualStudioEnvironment = { ...await environmentPromise };
		for (const [name, value] of Object.entries(environment)) {
			if (value !== process.env[name]) {
				visualStudioEnvironment[name] = value;
			}
		}
		return this.execution.execute(this.profile.executable, args, {
			cwd: workingDirectory,
			env: visualStudioEnvironment,
			cancellationToken,
		});
	}

	protected override async postProcessAssembly(
		rawAssembly: string,
		options: ProductionOptions,
		environment: NodeJS.ProcessEnv,
		workingDirectory: string,
		cancellationToken: CancellationToken,
	): Promise<string> {
		if (
			!options.demangle
			|| !this.capabilities.demangle
			|| !this.profile.tools.demangler
			|| !/^undname(?:\.exe)?$/i.test(path.basename(this.profile.tools.demangler))
		) {
			return super.postProcessAssembly(
				rawAssembly,
				options,
				environment,
				workingDirectory,
				cancellationToken,
			);
		}

		return withTemporaryDirectory('coglens-undname-', async temporaryDirectory => {
			const inputFile = path.join(temporaryDirectory, 'assembly.txt');
			await fs.promises.writeFile(inputFile, rawAssembly, 'utf8');
			const result = await this.execution.execute(this.profile.tools.demangler, [inputFile], {
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

	private async captureVisualStudioEnvironment(
		baseEnvironment: NodeJS.ProcessEnv,
		vcvarsArchitecture: string,
		cancellationToken: CancellationToken,
	): Promise<NodeJS.ProcessEnv> {
		if (!/^[a-z0-9_]+$/i.test(vcvarsArchitecture)) {
			throw new Error(`Unsupported Visual Studio architecture: ${vcvarsArchitecture}`);
		}

		const vcvarsScript = await this.findVisualStudioEnvironmentScript(baseEnvironment, cancellationToken);
		if (/["\r\n%!]/.test(vcvarsScript)) {
			throw new Error('The Visual Studio environment script path contains characters that cmd.exe cannot safely quote.');
		}

		const captureCommand = `call "${vcvarsScript}" ${vcvarsArchitecture} >nul && set`;
		const result = await this.execution.execute('cmd.exe', ['/d', '/s', '/c', captureCommand], {
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

	private async findVisualStudioEnvironmentScript(
		baseEnvironment: NodeJS.ProcessEnv,
		cancellationToken: CancellationToken,
	): Promise<string> {
		const programFilesX86 = baseEnvironment['ProgramFiles(x86)'] ?? baseEnvironment.PROGRAMFILES_X86;
		if (programFilesX86) {
			const vswhere = path.join(programFilesX86, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
			if (fs.existsSync(vswhere)) {
				try {
					const result = await this.execution.execute(vswhere, visualStudioDiscoveryArguments, {
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

		for (const candidate of visualStudioEnvironmentCandidates(this.profile.executable)) {
			if (fs.existsSync(candidate)) {
				return candidate;
			}
		}
		throw new Error(
			`Visual Studio environment script was not found through vswhere or relative to ${this.profile.executable}`,
		);
	}
}

export class MsvcCompiler extends WindowsToolchainBackend {
	constructor(
		profile: ToolchainProfile,
		capabilities: ToolchainCapabilities,
		execution?: ToolExecutionGate,
	) {
		super(profile, capabilities, execution);
		this.asmParser = new VcAsmParser();
	}
}

export class ClangClCompiler extends WindowsToolchainBackend {
	protected override prepareArguments(outputFile: string): readonly string[] {
		return ['/Z7', ...super.prepareArguments(outputFile)];
	}
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
