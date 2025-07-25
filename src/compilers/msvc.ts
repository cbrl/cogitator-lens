import * as path from 'path';
import * as fs from 'fs';
import * as exec from '../exec';
import { CompilerBase, CompilerInfo } from '../compiler';
import { VcAsmParser } from '../parsers/asm-parser-vc';
import { AsmParser } from '../parsers/asm-parser';
import * as logger from '../logger.js';

export abstract class WindowsCompilerBase extends CompilerBase {
	protected override prepareArgs(outputFile: string): string[] {
		return [
			'/nologo',
			'/c',
			'/FA',
			`/Fa${outputFile}`,
			`/Fo${outputFile}.obj`,
			`/Fd${outputFile}.pdb`
		];
	}
}

export class MsvcCompiler extends WindowsCompilerBase {
	public static get type(): string {
		return 'msvc';
	}

	public static baseCompilerInfo(name: string, exe: string): CompilerInfo {
		const info: CompilerInfo = {
			name: name,
			type: MsvcCompiler.type,
			exe: exe,

			includeFlag: '/I',
			defineFlag: '/D',

			supportsDemangle: true,
			supportsIntel: false,
			supportsLibraryCodeFilter: true
		};

		// Try to auto-detect demangler
		const demangler = exe.replace(/cl\.exe$/, 'undname.exe');

		if (fs.existsSync(demangler)) {
			info.demangler = fs.realpathSync(demangler);
		}

		return info;
	}

	public static isCompiler(exe: string): boolean {
		const lowerExe = path.basename(exe).toLowerCase();
		return lowerExe === 'cl.exe';
	}

	constructor(info: CompilerInfo) {
		super(info);
		this.asmParser = new VcAsmParser();
	}

	protected override async doCompile(file: string, args: string[], envVars: Record<string, string>): Promise<exec.ExecResult> {
		const parentDir = path.parse(this.info.exe).dir;
		const arch = path.parse(parentDir).base.replace('x64', 'amd64');
		const host = path.parse(path.parse(parentDir).dir).base.replace('Host', '').replace('x64', 'amd64');

		const vcvarsArch = (host === arch) ? arch : `${host}_${arch}`;
		const vcvarsScript = path.join(parentDir, '../'.repeat(6), 'Auxiliary/Build/vcvarsall.bat');

		const command = `"${vcvarsScript}" ${vcvarsArch} && cl.exe ${args.join(' ')} "${file}"`;

		logger.logChannel.info(`Final compile command: ${command}`);
		return exec.execute(command, [], {env: envVars, shell: true});
	}
}

export class ClangClCompiler extends WindowsCompilerBase {
	public static get type(): string {
		return 'clang-cl';
	}

	protected override prepareArgs(outputFile: string): string[] {
		// Enable debug info in the object file
		return ['/Z7', ...super.prepareArgs(outputFile)];
	}

	public static baseCompilerInfo(name: string, exe: string): CompilerInfo {
		const info = MsvcCompiler.baseCompilerInfo(name, exe);
		info.type = ClangClCompiler.type;
		info.supportsIntel = true;

		// Get the demangler from the Clang installation
		const demangler = path.join(path.dirname(exe), 'llvm-cxxfilt.exe');
		if (fs.existsSync(demangler)) {
			info.demangler = fs.realpathSync(demangler);
		}
		else {
			info.demangler = undefined;
		}

		return info;
	}

	public static isCompiler(exe: string): boolean {
		const lowerExe = path.basename(exe).toLowerCase();
		return lowerExe === 'clang-cl.exe';
	}
}
