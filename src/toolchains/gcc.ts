import { ToolchainBackend } from '../toolchains/toolchain-backend.js';
import type { ProductionOptions } from '../types/index.js';

export abstract class GnuStyleCompiler extends ToolchainBackend {
	protected override prepareArguments(outputFile: string): readonly string[] {
		return ['-S', ...this.lineTableArguments(), '-o', outputFile];
	}

	protected abstract lineTableArguments(): readonly string[];

	protected override outputOptionArguments(options: ProductionOptions): readonly string[] {
		return options.intel && this.capabilities.intelSyntax === 'selectable'
			? ['-masm=intel']
			: [];
	}
}

export class GccCompiler extends GnuStyleCompiler {
	protected lineTableArguments(): readonly string[] {
		return ['-g1'];
	}
}

export class ClangCompiler extends GnuStyleCompiler {
	protected lineTableArguments(): readonly string[] {
		return ['-gline-tables-only'];
	}
}

export class AppleClangCompiler extends ClangCompiler {}
