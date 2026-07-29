import type { ToolchainKind } from './types/index.js';
import { detectToolchainDefinition } from './toolchains/toolchain-map.js';

export function detectToolchainKind(
	executable: string,
	versionOutput = '',
	platform: NodeJS.Platform = process.platform,
): ToolchainKind | undefined {
	return detectToolchainDefinition(executable, versionOutput, platform)?.kind;
}
