import { structurallyEqual } from '../utils.js';

export interface ProductionOptions {
	readonly intel: boolean;
	readonly demangle: boolean;
}

export interface DisplayOptions {
	readonly showUnusedLabels: boolean;
	readonly showLibraryCode: boolean;
	readonly showDirectives: boolean;
	readonly showCommentOnlyLines: boolean;
	readonly trim: boolean;
	readonly showIncludedFiles: boolean;
	readonly showSystemDeclarations: boolean;
	readonly binaryColumns: boolean;
	readonly sourceLineColorBands: boolean;
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
		showUnusedLabels: false,
		showLibraryCode: true,
		showDirectives: false,
		showCommentOnlyLines: false,
		trim: false,
		showIncludedFiles: true,
		showSystemDeclarations: false,
		binaryColumns: true,
		sourceLineColorBands: true,
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
