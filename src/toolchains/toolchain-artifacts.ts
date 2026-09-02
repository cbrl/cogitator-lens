import type { ArtifactKind, ArtifactOptionAvailability, ArtifactOptionId, ToolchainProfile } from '../types/index.js';
import { artifactDefinitions } from '../artifacts/core/artifact-definitions.js';
import type { ResolvedToolchainArtifactCell, ToolchainArtifactCell, ToolchainArtifactOutput } from './toolchain-contracts.js';
import { getToolchainDefinition } from './toolchain-map.js';

/** Resolves a kind-level cell, including availability of its required auxiliary tools. */
export function resolveArtifactAvailability(profile: ToolchainProfile, kind: ArtifactKind): ToolchainArtifactCell {
	const cell = getToolchainDefinition(profile.kind).artifacts[kind];
	return cell.status === 'available' && cell.outputs ? cell : resolveImplementationAvailability(profile, cell);
}

/** Lists selectable outputs after accounting for the active toolchain profile. */
export function getArtifactOutputChoices(profile: ToolchainProfile, kind: ArtifactKind): readonly Pick<ToolchainArtifactOutput, 'id' | 'label' | 'description'>[] {
	const cell = resolveArtifactAvailability(profile, kind);
	return cell.status === 'available' && cell.outputs !== undefined
		? cell.outputs.map(({ id, label, description }) => ({ id, label, description })) : [];
}

/** Resolves a requested output ID to a producible cell or an explanatory unavailable cell. */
export function resolveArtifactOutput(profile: ToolchainProfile, kind: ArtifactKind, outputId?: string): ResolvedToolchainArtifactCell {
	const cell = getToolchainDefinition(profile.kind).artifacts[kind];
	if (cell.status !== 'available') {return resolveImplementationAvailability(profile, cell);}
	if (cell.outputs === undefined) {
		return outputId === undefined ? resolveImplementationAvailability(profile, cell) : {
			status: 'unsupported', explanation: `${artifactDefinitions[kind].label} does not accept an output selection.`,
		};
	}
	if (outputId === undefined) {return { status: 'unsupported', explanation: `Select an output for ${artifactDefinitions[kind].label.toLowerCase()}.` };}
	const output = cell.outputs.find((candidate) => candidate.id === outputId);
	if (!output) {return { status: 'unsupported', explanation: `${profile.displayName} does not support the ${outputId} output for ${artifactDefinitions[kind].label.toLowerCase()}.` };}
	return resolveImplementationAvailability(profile, { status: 'available', ...output });
}

/** Downgrades an otherwise available cell when any of its declared auxiliary tools is absent. */
function resolveImplementationAvailability(profile: ToolchainProfile, cell: ResolvedToolchainArtifactCell): ResolvedToolchainArtifactCell {
	const requiredTools = cell.status === 'available' ? [...(cell.requiredTool ? [cell.requiredTool] : []), ...(cell.requiredTools ?? [])] : [];
	const missingTool = requiredTools.find((tool) => !profile.tools[tool.name]);
	return cell.status === 'available' && missingTool ? {
		status: 'unavailable',
		explanation: `${missingTool.label} was not detected or configured as the ${missingTool.name} auxiliary tool for ${profile.displayName}.`,
	} : cell;
}

/** Determines whether an artifact display option is valid for this toolchain output. */
export function resolveArtifactOptionAvailability(profile: ToolchainProfile, kind: ArtifactKind, id: ArtifactOptionId): ArtifactOptionAvailability {
	const toolchain = getToolchainDefinition(profile.kind);
	const cell = toolchain.artifacts[kind];
	const definition = artifactDefinitions[kind];
	if (cell.status === 'available' && cell.outputs === undefined &&
		(cell.listingSyntax ?? definition.listingSyntax) !== definition.listingSyntax) {
		const listingSyntax = cell.listingSyntax?.replaceAll('-', ' ') ?? 'toolchain-specific output';
		const defaultListingSyntax = definition.listingSyntax?.replaceAll('-', ' ') ?? 'the default listing syntax';
		return { status: 'unsupported', explanation: `${profile.displayName} emits ${listingSyntax} rather than ${defaultListingSyntax}.` };
	}
	const artifact = resolveArtifactAvailability(profile, kind);
	if (artifact.status !== 'available') {return artifact;}
	if (id === 'demangle') {return profile.tools.demangler ? { status: 'available' } : {
		status: 'unavailable', explanation: `No demangler was detected or configured for ${profile.displayName}.`,
	};}
	if (id === 'intel') {
		const intelSyntax = toolchain.intelSyntax ?? 'unsupported';
		if (intelSyntax === 'selectable') {return { status: 'available' };}
		return intelSyntax === 'inherent'
			? { status: 'unavailable', explanation: `${profile.displayName} already emits Intel syntax.`, reason: 'inherent' }
			: { status: 'unsupported', explanation: `${profile.displayName} does not support selectable Intel syntax.` };
	}
	return { status: 'available' };
}
