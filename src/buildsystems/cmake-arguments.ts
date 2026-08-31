import type { ToolchainKind } from '../types/index.js';
import { getToolchainDefinition } from '../toolchains/toolchain-map.js';

export function flattenCmakeArguments(
	argumentsList: readonly string[],
	includes: readonly string[],
	defines: readonly string[],
	kind: ToolchainKind,
): string[] {
	const definition = getToolchainDefinition(kind);
	return [
		...argumentsList,
		...(definition.includeFlag ? includes.map((value) => `${definition.includeFlag}${value}`) : []),
		...(definition.defineFlag ? defines.map((value) => `${definition.defineFlag}${value}`) : []),
	];
}
