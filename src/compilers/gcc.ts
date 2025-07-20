import * as fs from 'fs';
import { CompilerBase, CompilerInfo } from '../compiler';

export class GccCompiler extends CompilerBase {
	public static get type(): string {
		return 'gcc';
	}

	public static baseCompilerInfo(name: string, exe: string): CompilerInfo {
		const info: CompilerInfo = {
			name: name,
			type: GccCompiler.type,
			exe: exe,

			includeFlag: '-I',
			defineFlag: '-D',

			supportsDemangle: true,
			supportsIntel: true,
			supportsLibraryCodeFilter: true
		};

		// Try to auto-detect demangler by replacing 'gcc[-version]' or 'g++[-version]' with 'c++filt'.
		const demangler = exe.replace(/(gcc|g\+\+)(-\d+\.\d+)?$/, 'c++filt');

		if (fs.existsSync(demangler)) {
			info.demangler = fs.realpathSync(demangler);
		}

		return info;
	}

	public static isCompiler(exe: string): boolean {
		const lowerExe = exe.toLowerCase();
		return lowerExe.includes('gcc') || lowerExe.includes('g++');
	}

	protected override prepareArgs(outputFile: string): string[] {
		return ['-S', '-o', outputFile];
	}
}
