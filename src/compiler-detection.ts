import type { CompilerKind } from './types/index.js';
import { getCompilerByExe } from './compilers/compiler-map.js';

export function detectCompilerKind(
	executable: string,
	versionOutput = '',
	platform: NodeJS.Platform = process.platform,
): CompilerKind | undefined {
	return getCompilerByExe(executable, versionOutput, platform)?.type;
}
