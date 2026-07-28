import fs from 'fs';
import path from 'path';
import { CompilerBase } from '../compiler.js';
import * as exec from '../exec.js';
import type { CancellationToken } from 'vscode';
import type { CompilerKind, CompilerProfile } from '../types/index.js';
import { VcAsmParser } from '../parsers/asm-parser-vc.js';

abstract class WindowsCompilerBase extends CompilerBase {
	private static readonly environmentCache = new Map<string, Promise<NodeJS.ProcessEnv>>();

	protected override prepareArguments(outputFile: string): readonly string[] {
		return ['/nologo', '/c', '/FAcs', `/Fa${outputFile}`, `/Fo${outputFile}.obj`, `/Fd${outputFile}.pdb`];
	}

	protected override async runCompiler(
		args: readonly string[],
		environment: NodeJS.ProcessEnv,
		workingDirectory: string,
		cancellationToken: CancellationToken,
	): Promise<exec.ExecResult> {
		const architecture = vcvarsArchitecture(this.profile.executable);
		const cacheKey = `${path.normalize(this.profile.executable).toLowerCase()}\0${architecture}`;
		let environmentPromise = WindowsCompilerBase.environmentCache.get(cacheKey);
		if (!environmentPromise) {
			environmentPromise = this.captureVisualStudioEnvironment(
				{ ...process.env },
				architecture,
				cancellationToken,
			);
			WindowsCompilerBase.environmentCache.set(cacheKey, environmentPromise);
			void environmentPromise.catch(() => {
				if (WindowsCompilerBase.environmentCache.get(cacheKey) === environmentPromise) {
					WindowsCompilerBase.environmentCache.delete(cacheKey);
				}
			});
		}
		const visualStudioEnvironment = { ...await environmentPromise };
		for (const [name, value] of Object.entries(environment)) {
			if (value !== process.env[name]) {
				visualStudioEnvironment[name] = value;
			}
		}
		return exec.execute(this.profile.executable, args, {
			cwd: workingDirectory,
			env: visualStudioEnvironment,
			cancellationToken,
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
		const result = await exec.execute('cmd.exe', ['/d', '/s', '/c', captureCommand], {
			env: baseEnvironment,
			cancellationToken,
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
					const result = await exec.execute(vswhere, [
						'-latest',
						'-products',
						'*',
						'-requires',
						'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
						'-property',
						'installationPath',
					], {
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
					if (error instanceof exec.ExecError && error.kind === 'cancelled') {
						throw error;
					}
				}
			}
		}

		const compilerDirectory = path.dirname(this.profile.executable);
		const fallback = path.resolve(
			compilerDirectory,
			'..',
			'..',
			'..',
			'..',
			'..',
			'..',
			'Auxiliary',
			'Build',
			'vcvarsall.bat',
		);
		if (fs.existsSync(fallback)) {
			return fallback;
		}
		throw new Error(
			`Visual Studio environment script was not found through vswhere or relative to ${this.profile.executable}`,
		);
	}
}

export class MsvcCompiler extends WindowsCompilerBase {
	static readonly type: CompilerKind = 'msvc';

	static baseCompilerProfile(displayName: string, executable: string): CompilerProfile {
		const demangler = executable.replace(/cl\.exe$/i, 'undname.exe');
		return makeWindowsProfile(displayName, executable, MsvcCompiler.type, fs.existsSync(demangler) ? demangler : undefined);
	}

	static isCompiler(executable: string): boolean {
		return /^cl\.exe$/i.test(path.basename(executable));
	}

	constructor(profile: CompilerProfile) {
		super(profile);
		this.asmParser = new VcAsmParser();
	}
}

export class ClangClCompiler extends WindowsCompilerBase {
	static readonly type: CompilerKind = 'clang-cl';

	static baseCompilerProfile(displayName: string, executable: string): CompilerProfile {
		const demangler = path.join(path.dirname(executable), 'llvm-cxxfilt.exe');
		return makeWindowsProfile(displayName, executable, ClangClCompiler.type, fs.existsSync(demangler) ? demangler : undefined);
	}

	static isCompiler(executable: string): boolean {
		return /^clang-cl(?:\.exe)?$/i.test(path.basename(executable));
	}

	protected override prepareArguments(outputFile: string): readonly string[] {
		return ['/Z7', ...super.prepareArguments(outputFile)];
	}
}

function makeWindowsProfile(
	displayName: string,
	executable: string,
	kind: CompilerKind,
	demangler?: string,
): CompilerProfile {
	const normalized = path.normalize(executable);
	return {
		id: `detected:${normalized.toLowerCase()}`,
		displayName,
		kind,
		executable: normalized,
		defaultArguments: [],
		includes: [],
		defines: [],
		environment: {},
		includeFlag: '/I',
		defineFlag: '/D',
		demangler,
		capabilities: {
			demangle: demangler !== undefined,
			intelSyntax: kind === 'clang-cl',
			libraryCodeFilter: true,
		},
	};
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
