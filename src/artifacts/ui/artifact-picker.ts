import type {
	ArtifactKind,
	ArtifactOptionAvailability,
} from '../../types/index.js';
import type { QuickPickItem } from 'vscode';

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

export function partitionArtifactPickerChoices(
	choices: readonly ArtifactPickerChoice[],
): ArtifactPickerSections {
	return {
		available: choices.filter(choice => choice.availability.status === 'available'),
		unavailable: choices.filter(choice => choice.availability.status === 'unavailable'),
	};
}
