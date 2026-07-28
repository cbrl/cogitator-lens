import path from 'path';
import type { CompilerKind } from './types/index.js';

export function detectCompilerKind(
	executable: string,
	versionOutput = '',
	platform: NodeJS.Platform = process.platform,
): CompilerKind | undefined {
	const basename = path.basename(executable);
	if (/^clang-cl(?:\.exe)?$/i.test(basename)) {
		return 'clang-cl';
	}
	if (/^cl\.exe$/i.test(basename)) {
		return 'msvc';
	}
	if (/^(?:gcc|g\+\+)(?:-\d+(?:\.\d+)*)?(?:\.exe)?$/i.test(basename)) {
		return 'gcc';
	}
	if (/^clang(?:\+\+)?(?:-\d+(?:\.\d+)*)?(?:\.exe)?$/i.test(basename)) {
		return /apple clang/i.test(versionOutput) || platform === 'darwin' ? 'apple-clang' : 'clang';
	}
	return undefined;
}
