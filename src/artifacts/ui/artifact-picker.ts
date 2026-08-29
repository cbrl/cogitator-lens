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

/** Theme icon IDs for artifact kinds in the open-artifact picker. */
export const artifactPickerIcons = {
	assembly: 'symbol-method',
	'binary-disassembly': 'package',
	'preprocessed-source': 'file-code',
	ast: 'symbol-structure',
	'llvm-ir': 'circuit-board',
	'rust-mir': 'symbol-namespace',
	'optimization-remarks': 'lightbulb',
	'stack-analysis': 'layers',
	'python-bytecode': 'symbol-number',
	'control-flow-graph': 'type-hierarchy',
} as const satisfies Record<ArtifactKind, string>;

export function artifactPickerIcon(kind: ArtifactKind): string {
	return artifactPickerIcons[kind];
}

export function partitionArtifactPickerChoices(
	choices: readonly ArtifactPickerChoice[],
): ArtifactPickerSections {
	return {
		available: choices.filter(choice => choice.availability.status === 'available'),
		unavailable: choices.filter(choice => choice.availability.status === 'unavailable'),
	};
}
