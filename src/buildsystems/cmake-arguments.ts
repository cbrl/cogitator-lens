import type { ToolchainKind } from '../types/index.js';
import { toolchainDefinitions } from '../toolchains/toolchain-map.js';

export function flattenCmakeArguments(
	argumentsList: readonly string[],
	includes: readonly string[],
	defines: readonly string[],
	kind: ToolchainKind,
): string[] {
	const definition = toolchainDefinitions[kind];
	return [
		...argumentsList,
		...includes.map(item => `${definition.includeFlag}${item}`),
		...defines.map(item => `${definition.defineFlag}${item}`),
	];
}
