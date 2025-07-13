import { CompilerBase } from '../compiler';

export class GccCompiler extends CompilerBase {
	public static get type(): string {
		return 'gcc';
	}

	protected override prepareArgs(outputFile: string): string[] {
		return ['-S', '-o', outputFile];
	}
}
