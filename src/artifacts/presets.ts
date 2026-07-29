import type { ProductionOptions } from '../types/index.js';

export interface ArtifactPreset {
	readonly id: string;
	readonly extraArguments: readonly string[];
	readonly productionOptions: Partial<ProductionOptions>;
}

export const defaultArtifactPreset: ArtifactPreset = Object.freeze({
	id: 'default',
	extraArguments: Object.freeze([]),
	productionOptions: Object.freeze({}),
});

export function effectiveArtifactPresets(
	configured: readonly ArtifactPreset[] = [],
): ReadonlyMap<string, ArtifactPreset> {
	return new Map([
		[defaultArtifactPreset.id, defaultArtifactPreset],
		...configured.map(preset => [preset.id, Object.freeze({
			...preset,
			extraArguments: Object.freeze([...preset.extraArguments]),
			productionOptions: Object.freeze({ ...preset.productionOptions }),
		})] as const),
	]);
}

export function resolveArtifactPreset(
	id: string,
	configured: readonly ArtifactPreset[] = [],
): ArtifactPreset | undefined {
	return effectiveArtifactPresets(configured).get(id);
}
