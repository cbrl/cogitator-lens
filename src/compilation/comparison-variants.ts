import { getToolchainDefinition } from '../toolchains/toolchain-map.js';
import type { CompilationVariant, ToolchainKind, ToolchainProfile } from '../types/index.js';

const prefix = 'compare:';

/**
 * The ID of a variant that compiles a source with another toolchain. It names the toolchain and
 * the variant whose settings it uses, so an artifact URI can find the variant again.
 */
export function toolchainComparisonVariantId(toolchainProfileId: string, baseVariantId: string): string {
	return `${prefix}${encodeURIComponent(toolchainProfileId)}:${encodeURIComponent(baseVariantId)}`;
}

/** Reads a comparison variant ID, or nothing for another ID. */
export function parseToolchainComparisonVariantId(
	variantId: string,
): { readonly toolchainProfileId: string; readonly baseVariantId: string } | undefined {
	const match = /^compare:([^:]*):(.+)$/.exec(variantId);
	if (!match) {
		return undefined;
	}
	try {
		return { toolchainProfileId: decodeURIComponent(match[1]), baseVariantId: decodeURIComponent(match[2]) };
	} catch {
		return undefined;
	}
}

/** Toolchains with the same dialect read the same compiler arguments. */
export function argumentDialect(kind: ToolchainKind): string {
	return getToolchainDefinition(kind).argumentDialect ?? kind;
}

/**
 * A variant that compiles the source of the base variant with another toolchain. It keeps the
 * arguments and the environment of the base variant only when both toolchains read the same arguments.
 */
export function toolchainComparisonVariant(
	base: CompilationVariant,
	baseKind: ToolchainKind | undefined,
	profile: ToolchainProfile,
): { readonly variant: CompilationVariant; readonly argumentsDropped: boolean } {
	const keepArguments = baseKind !== undefined && argumentDialect(baseKind) === argumentDialect(profile.kind);
	const argumentsDropped = !keepArguments && (base.arguments.length > 0 || Object.keys(base.environment).length > 0);
	return {
		variant: {
			id: toolchainComparisonVariantId(profile.id, base.id),
			provider: 'default',
			source: base.source,
			toolchainProfileId: profile.id,
			workingDirectory: base.workingDirectory,
			arguments: keepArguments ? base.arguments : [],
			environment: keepArguments ? base.environment : {},
			displayLabel: keepArguments
				? `${profile.displayName} (settings of ${base.displayLabel})`
				: `${profile.displayName}`,
		},
		argumentsDropped,
	};
}
