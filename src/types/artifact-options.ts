import { structurallyEqual } from '../utils.js';

export interface ProductionOptions {
	readonly intel: boolean;
	readonly demangle: boolean;
}

export interface DisplayOptions {
	readonly labels: boolean;
	readonly libraryCode: boolean;
	readonly directives: boolean;
	readonly commentOnly: boolean;
	readonly trim: boolean;
	readonly dontMaskFilenames: boolean;
	readonly showIncludedFiles: boolean;
	readonly showSystemDeclarations: boolean;
}

export interface ArtifactOptions {
	readonly production: ProductionOptions;
	readonly display: DisplayOptions;
}

export type ProductionOptionId = keyof ProductionOptions;
export type DisplayOptionId = keyof DisplayOptions;
export type ArtifactOptionId = ProductionOptionId | DisplayOptionId;

export const defaultArtifactOptions: ArtifactOptions = Object.freeze({
	production: Object.freeze({
		intel: false,
		demangle: false,
	}),
	display: Object.freeze({
		labels: true,
		libraryCode: false,
		directives: true,
		commentOnly: true,
		trim: false,
		dontMaskFilenames: true,
		showIncludedFiles: true,
		showSystemDeclarations: false,
	}),
});

export function immutableArtifactOptions(options: ArtifactOptions): ArtifactOptions {
	return Object.freeze({
		production: Object.freeze({ ...options.production }),
		display: Object.freeze({ ...options.display }),
	});
}

export function artifactOptionsEqual(left: ArtifactOptions, right: ArtifactOptions): boolean {
	return structurallyEqual(left, right);
}
