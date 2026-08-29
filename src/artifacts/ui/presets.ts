import type { ArtifactKind, ProductionOptions } from '../../types/index.js';

export interface ArtifactPreset {
	readonly id: string;
	readonly artifactKind: ArtifactKind;
	readonly extraArguments: readonly string[];
	readonly productionOptions: Partial<ProductionOptions>;
}

export type ArtifactPresetConfiguration = Omit<ArtifactPreset, 'id'>;

export function defaultArtifactPreset(artifactKind: ArtifactKind): ArtifactPreset {
	return Object.freeze({
		id: 'default',
		artifactKind,
		extraArguments: Object.freeze([]),
		productionOptions: Object.freeze({}),
	});
}

export function effectiveArtifactPresets(
	configured: readonly ArtifactPreset[] = [],
	artifactKind: ArtifactKind = 'assembly',
): ReadonlyMap<string, ArtifactPreset> {
	return new Map([
		['default', defaultArtifactPreset(artifactKind)],
		...configured
			.filter(preset => preset.artifactKind === artifactKind)
			.map(preset => [preset.id, Object.freeze({
			...preset,
			extraArguments: Object.freeze([...preset.extraArguments]),
			productionOptions: Object.freeze({ ...preset.productionOptions }),
		})] as const),
	]);
}

export function resolveArtifactPreset(
	id: string,
	configured: readonly ArtifactPreset[] = [],
	artifactKind: ArtifactKind = 'assembly',
): ArtifactPreset | undefined {
	return effectiveArtifactPresets(configured, artifactKind).get(id);
}
