import fs from 'fs';
import path from 'path';
import { CompilerBase } from '../compiler.js';
import * as exec from '../exec.js';
import type { CancellationToken } from 'vscode';
import type { CompilerKind, CompilerProfile } from '../types/index.js';
import { VcAsmParser } from '../parsers/asm-parser-vc.js';

abstract class WindowsCompilerBase extends CompilerBase {
	protected override prepareArguments(outputFile: string): readonly string[] {
		return ['/nologo', '/c', '/FAcs', `/Fa${outputFile}`, `/Fo${outputFile}.obj`, `/Fd${outputFile}.pdb`];
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

	protected override async runCompiler(
		args: readonly string[],
		environment: NodeJS.ProcessEnv,
		workingDirectory: string,
		cancellationToken: CancellationToken,
	): Promise<exec.ExecResult> {
		const visualStudioEnvironment = await this.captureVisualStudioEnvironment(environment, cancellationToken);
		return exec.execute(this.profile.executable, args, {
			cwd: workingDirectory,
			env: visualStudioEnvironment,
			cancellationToken,
		});
	}

	private async captureVisualStudioEnvironment(
		baseEnvironment: NodeJS.ProcessEnv,
		cancellationToken: CancellationToken,
	): Promise<NodeJS.ProcessEnv> {
		const compilerDirectory = path.dirname(this.profile.executable);
		const architecture = path.basename(compilerDirectory).replace(/^x64$/i, 'amd64');
		const hostDirectory = path.basename(path.dirname(compilerDirectory));
		const host = hostDirectory.replace(/^Host/i, '').replace(/^x64$/i, 'amd64');

		const vcvarsArchitecture = host === architecture ? architecture : `${host}_${architecture}`;
		if (!/^[a-z0-9_]+$/i.test(vcvarsArchitecture)) {
			throw new Error(`Unsupported Visual Studio architecture: ${vcvarsArchitecture}`);
		}

		const vcvarsScript = path.resolve(compilerDirectory, '..', '..', '..', '..', '..', '..', 'Auxiliary', 'Build', 'vcvarsall.bat');
		if (!fs.existsSync(vcvarsScript)) {
			throw new Error(`Visual Studio environment script was not found: ${vcvarsScript}`);
		}
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
