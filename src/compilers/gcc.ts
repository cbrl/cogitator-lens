import fs from 'fs';
import path from 'path';
import { CompilerBase } from '../compiler.js';
import type { CompilerKind, CompilerProfile } from '../types/index.js';
import type { CompilerOutputOptions } from '../parsers/filters.interfaces.js';

export abstract class GnuStyleCompiler extends CompilerBase {
	protected override prepareArguments(outputFile: string): readonly string[] {
		return ['-S', ...this.lineTableArguments(), '-o', outputFile];
	}

	protected abstract lineTableArguments(): readonly string[];

	protected override outputOptionArguments(options: CompilerOutputOptions): readonly string[] {
		return options.intel ? ['-masm=intel'] : [];
	}
}

export class GccCompiler extends GnuStyleCompiler {
	static readonly type: CompilerKind = 'gcc';

	static baseCompilerProfile(displayName: string, executable: string): CompilerProfile {
		const demanglerCandidate = executable.replace(
			/(?:gcc|g\+\+)(?:-\d+(?:\.\d+)*)?(?:\.exe)?$/i,
			process.platform === 'win32' ? 'c++filt.exe' : 'c++filt',
		);
		return makeProfile(displayName, executable, GccCompiler.type, fs.existsSync(demanglerCandidate) ? demanglerCandidate : undefined);
	}

	static isCompiler(executable: string): boolean {
		return /^(?:gcc|g\+\+)(?:-\d+(?:\.\d+)*)?(?:\.exe)?$/i.test(path.basename(executable));
	}

	protected lineTableArguments(): readonly string[] {
		return ['-g1'];
	}
}

export class ClangCompiler extends GnuStyleCompiler {
	static readonly type: CompilerKind = 'clang';

	static baseCompilerProfile(displayName: string, executable: string): CompilerProfile {
		const demangler = path.join(path.dirname(executable), process.platform === 'win32' ? 'llvm-cxxfilt.exe' : 'llvm-cxxfilt');
		return makeProfile(displayName, executable, ClangCompiler.type, fs.existsSync(demangler) ? demangler : undefined);
	}

	static isCompiler(executable: string): boolean {
		return /^clang(?:\+\+)?(?:-\d+(?:\.\d+)*)?(?:\.exe)?$/i.test(path.basename(executable));
	}

	protected lineTableArguments(): readonly string[] {
		return ['-gline-tables-only'];
	}
}

export class AppleClangCompiler extends ClangCompiler {
	static readonly type: CompilerKind = 'apple-clang';

	static override baseCompilerProfile(displayName: string, executable: string): CompilerProfile {
		return { ...ClangCompiler.baseCompilerProfile(displayName, executable), kind: AppleClangCompiler.type };
	}
}

function makeProfile(
	displayName: string,
	executable: string,
	kind: CompilerKind,
	demangler?: string,
): CompilerProfile {
	const normalized = path.normalize(executable);
	return {
		id: `detected:${process.platform === 'win32' ? normalized.toLowerCase() : normalized}`,
		displayName,
		kind,
		executable: normalized,
		defaultArguments: [],
		includes: [],
		defines: [],
		environment: {},
		includeFlag: '-I',
		defineFlag: '-D',
		demangler,
		capabilities: {
			demangle: demangler !== undefined,
			intelSyntax: true,
			libraryCodeFilter: true,
		},
	};
}
