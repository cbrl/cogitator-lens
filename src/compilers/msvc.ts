import * as path from 'path';
import * as exec from '../exec';
import { CompilerBase, CompilerInfo } from '../compiler';
import { VcAsmParser } from '../parsers/asm-parser-vc';
import { AsmParser } from '../parsers/asm-parser';

export class MsvcCompiler extends CompilerBase {
	public static get type(): string {
		return 'msvc';
	}

	constructor(info: CompilerInfo) {
		super(info);
		this.asmParser = new VcAsmParser();
		this.getVariables();
	}

	protected override prepareArgs(outputFile: string): string[] {
		return ['/c', '/FA', `/Fa${outputFile}`];
	}

	private async getVariables(): Promise<void> {
		const parentDir = path.parse(this.info.exe).dir;
		const arch = path.parse(parentDir).base.replace('x64', 'amd64');
		const host = path.parse(path.parse(parentDir).dir).base.replace('Host', '').replace('x64', 'amd64');

		const vcvarsArch = (host === arch) ? arch : `${host}_${arch}`;
		const vcvarsScript = path.join(parentDir, '../'.repeat(6), 'Auxiliary/Build/vcvarsall.bat');

		// Setup compile environment and print include and library paths with an easily searchable prefix
		const includeCommand = `cmd /V:ON /C ""${vcvarsScript}" ${vcvarsArch} && echo @INCLUDE:!INCLUDE!"`;
		const libCommand = `cmd /V:ON /C ""${vcvarsScript}" ${vcvarsArch} && echo @LIB:!LIB!"`;

		// Synchronously execute commands
		//const includeOutput = new TextDecoder().decode(child_process.execSync(includeCommand, {shell: 'cmd'}));
		//const libOutput = new TextDecoder().decode(child_process.execSync(libCommand, {shell: 'cmd'}));

		return Promise.all([
			exec.execute(includeCommand, [], {}, true),
			exec.execute(libCommand, [], {}, true)
		]).then(([includeOutput, libOutput]) => {
			const includePaths = includeOutput.stdout.split('@INCLUDE:')[1].trim();
			const libPaths = libOutput.stdout.split('@LIB:')[1].trim();

			this.info.envVars ??= {};
			this.info.envVars['INCLUDE'] = includePaths;
		}).catch(reason => {
			// TODO: print error
		});
	}
}

export class ClangClCompiler extends MsvcCompiler {
	public static override get type(): string {
		return 'clang-cl';
	}

	constructor(info: CompilerInfo) {
		super(info);
		this.asmParser = new AsmParser();
	}
}