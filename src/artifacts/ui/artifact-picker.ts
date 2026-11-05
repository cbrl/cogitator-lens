import type { ArtifactKind, ArtifactOptionAvailability } from '../../types/index.js';
import type { QuickPickItem } from 'vscode';
import { getArtifactKind } from '../core/artifact-definitions.js';

export interface ArtifactPickerChoice {
	readonly artifactKind: ArtifactKind;
	readonly label: string;
	readonly iconPath?: QuickPickItem['iconPath'];
	readonly availability: ArtifactOptionAvailability;
}

export interface ArtifactPickerSections {
	readonly available: readonly ArtifactPickerChoice[];
	readonly unavailable: readonly ArtifactPickerChoice[];
}

/** The most artifact kinds that the recent-use list keeps. */
const recentKindLimit = 20;

export function partitionArtifactPickerChoices(
	choices: readonly ArtifactPickerChoice[],
	recentKinds: readonly ArtifactKind[] = [],
): ArtifactPickerSections {
	return {
		available: orderByRecentUse(
			choices.filter((choice) => choice.availability.status === 'available'),
			recentKinds,
		),
		unavailable: choices.filter((choice) => choice.availability.status === 'unavailable'),
	};
}

/** Puts the recently used kinds first, the most recent first. The other kinds keep their order. */
export function orderByRecentUse<T extends { readonly artifactKind: ArtifactKind }>(
	choices: readonly T[],
	recentKinds: readonly ArtifactKind[],
): T[] {
	const rank = new Map(recentKinds.map((kind, index) => [kind, index]));
	const unused = recentKinds.length;
	return [...choices].sort(
		(left, right) => (rank.get(left.artifactKind) ?? unused) - (rank.get(right.artifactKind) ?? unused),
	);
}

/** Reads a stored recent-use list. Unknown and repeated kinds are left out. */
export function recentArtifactKinds(stored: unknown): ArtifactKind[] {
	if (!Array.isArray(stored)) {
		return [];
	}
	const kinds = stored.flatMap((value) => (typeof value === 'string' ? (getArtifactKind(value) ?? []) : []));
	return [...new Set(kinds)].slice(0, recentKindLimit);
}

/** The recent-use list after a use of one kind. */
export function withRecentUse(recentKinds: readonly ArtifactKind[], kind: ArtifactKind): ArtifactKind[] {
	return [kind, ...recentKinds.filter((candidate) => candidate !== kind)].slice(0, recentKindLimit);
}
