import type { ArtifactKind, ArtifactOptionAvailability, ArtifactOptionId, ToolchainProfile } from '../types/index.js';
import { artifactDefinitions } from '../artifacts/core/artifact-definitions.js';
import type { ArtifactImplementation, ArtifactOutput } from './toolchain-contracts.js';
import { getToolchainDefinition } from './toolchain-map.js';

type Unavailable = Exclude<ArtifactOptionAvailability, { readonly status: 'available' }>;

/** The implementation that produces a requested artifact, or the reason that none can. */
export type ResolvedArtifactImplementation =
	{ readonly status: 'available'; readonly implementation: ArtifactImplementation } | Unavailable;

/** Resolves whether a toolchain profile can produce an artifact kind, including its required tools. */
export function resolveArtifactAvailability(profile: ToolchainProfile, kind: ArtifactKind): ArtifactOptionAvailability {
	const support = getToolchainDefinition(profile.kind).artifacts[kind];
	if (!support) {
		return unsupported(kind);
	}
	const resolved = support.outputs ? undefined : withRequiredTools(profile, support);
	return resolved?.status === 'unavailable' ? resolved : { status: 'available' };
}

/** Lists the selectable outputs of an artifact kind. */
export function getArtifactOutputChoices(
	profile: ToolchainProfile,
	kind: ArtifactKind,
): readonly Pick<ArtifactOutput, 'id' | 'label' | 'description'>[] {
	const support = getToolchainDefinition(profile.kind).artifacts[kind];
	return support?.outputs?.map(({ id, label, description }) => ({ id, label, description })) ?? [];
}

/** Resolves an artifact kind and optional output ID to the implementation that produces it. */
export function resolveArtifactImplementation(
	profile: ToolchainProfile,
	kind: ArtifactKind,
	outputId?: string,
): ResolvedArtifactImplementation {
	const support = getToolchainDefinition(profile.kind).artifacts[kind];
	const label = artifactDefinitions[kind].label;
	if (!support) {
		return unsupported(kind);
	}
	if (!support.outputs) {
		return outputId === undefined
			? withRequiredTools(profile, support)
			: { status: 'unsupported', explanation: `${label} does not accept an output selection.` };
	}
	if (outputId === undefined) {
		return { status: 'unsupported', explanation: `Select an output for ${label.toLowerCase()}.` };
	}
	const output = support.outputs.find((candidate) => candidate.id === outputId);
	return output
		? withRequiredTools(profile, output)
		: {
				status: 'unsupported',
				explanation: `${profile.displayName} does not support the ${outputId} output for ${label.toLowerCase()}.`,
			};
}

function unsupported(kind: ArtifactKind): Unavailable {
	return {
		status: 'unsupported',
		explanation: `This toolchain has no ${artifactDefinitions[kind].label.toLowerCase()} producer.`,
	};
}

/** Makes an implementation unavailable when one of its required auxiliary tools is absent. */
function withRequiredTools(
	profile: ToolchainProfile,
	implementation: ArtifactImplementation,
): ResolvedArtifactImplementation {
	const missingTool = implementation.requiredTools?.find((tool) => !profile.tools[tool.name]);
	return missingTool
		? {
				status: 'unavailable',
				explanation: `${missingTool.label} was not detected or configured as the ${missingTool.name} auxiliary tool for ${profile.displayName}.`,
			}
		: { status: 'available', implementation };
}

/** Determines whether an artifact display option is valid for this toolchain output. */
export function resolveArtifactOptionAvailability(
	profile: ToolchainProfile,
	kind: ArtifactKind,
	id: ArtifactOptionId,
): ArtifactOptionAvailability {
	const toolchain = getToolchainDefinition(profile.kind);
	const support = toolchain.artifacts[kind];
	const definition = artifactDefinitions[kind];
	if (
		support &&
		!support.outputs &&
		(support.listingSyntax ?? definition.listingSyntax) !== definition.listingSyntax
	) {
		const listingSyntax = support.listingSyntax?.replaceAll('-', ' ') ?? 'toolchain-specific output';
		const defaultListingSyntax = definition.listingSyntax?.replaceAll('-', ' ') ?? 'the default listing syntax';
		return {
			status: 'unsupported',
			explanation: `${profile.displayName} emits ${listingSyntax} rather than ${defaultListingSyntax}.`,
		};
	}
	const artifact = resolveArtifactAvailability(profile, kind);
	if (artifact.status !== 'available') {
		return artifact;
	}
	if (id === 'demangle') {
		return profile.tools.demangler
			? { status: 'available' }
			: {
					status: 'unavailable',
					explanation: `No demangler was detected or configured for ${profile.displayName}.`,
				};
	}
	if (id === 'intel') {
		const intelSyntax = toolchain.intelSyntax ?? 'unsupported';
		if (intelSyntax === 'selectable') {
			return { status: 'available' };
		}
		return intelSyntax === 'inherent'
			? {
					status: 'unavailable',
					explanation: `${profile.displayName} already emits Intel syntax.`,
					reason: 'inherent',
				}
			: {
					status: 'unsupported',
					explanation: `${profile.displayName} does not support selectable Intel syntax.`,
				};
	}
	return { status: 'available' };
}
