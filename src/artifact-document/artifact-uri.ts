import { Uri } from 'vscode';
import path from 'path';
import type { ArtifactKind, CompilationVariant } from '../types/index.js';
import { artifactDefinitions, getArtifactKind } from '../artifacts/core/artifact-definitions.js';
import type { ArtifactViewOptions } from '../artifacts/core/artifact-views.js';
import { artifactScheme } from './artifact-scheme.js';

export { artifactScheme };

export type { ArtifactViewOptions };

export interface ArtifactUriIdentity {
	readonly source: Uri;
	readonly variantId: string;
	readonly artifactKind: ArtifactKind;
	readonly presetId: string;
	readonly artifactOutputId?: string;
	/** Present only when the document shows a view of the listing, not the full listing. */
	readonly view?: ArtifactViewOptions;
}

export function getArtifactUri(
	source: Uri,
	variant: Pick<CompilationVariant, 'id'>,
	artifactKind: ArtifactKind,
	presetId: string,
	artifactOutputId?: string,
	view: ArtifactViewOptions = {},
): Uri {
	const definition = artifactDefinitions[artifactKind];
	if (definition.presentation !== 'text' && hasView(view)) {
		throw new Error(`${definition.label} documents do not accept a listing view.`);
	}
	if (definition.requiresOutputSelection && !artifactOutputId) {
		throw new Error(`${definition.label} URIs require an output selection.`);
	}
	if (!definition.requiresOutputSelection && artifactOutputId) {
		throw new Error(`${artifactKind} URIs do not accept an output selection.`);
	}
	const query = new URLSearchParams({
		source: source.toString(),
		variant: variant.id,
		artifact: artifactKind,
		preset: presetId,
	});
	if (artifactOutputId) {
		query.set('output', artifactOutputId);
	}
	if (view.normalized) {
		query.set('view', 'normalized');
	}
	if (view.functionName !== undefined) {
		query.set('function', view.functionName);
	}
	return source.with({
		scheme: artifactScheme,
		path: artifactPath(source.path, artifactKind),
		query: query.toString(),
		fragment: '',
	});
}

/**
 * Replaces the source extension with the artifact suffix. A URI path always uses forward slashes, so
 * the platform path module must not change it. On Windows, it would write backslashes.
 */
function artifactPath(sourcePath: string, artifactKind: ArtifactKind): string {
	const definition = artifactDefinitions[artifactKind];
	const sourceExtension = path.posix.extname(sourcePath);
	const stem = sourcePath.slice(0, sourcePath.length - sourceExtension.length);
	const languageExtension = definition.documentLanguage === 'source' ? sourceExtension : '';
	return `${stem}${definition.filenameExtension}${languageExtension}`;
}

export function parseArtifactUri(uri: Uri): ArtifactUriIdentity | undefined {
	if (uri.scheme !== artifactScheme) {
		return undefined;
	}
	const query = new URLSearchParams(uri.query);
	const rawSource = query.get('source');
	const variantId = query.get('variant');
	const configuredKind = query.get('artifact');
	const artifactKind = configuredKind ? getArtifactKind(configuredKind) : undefined;
	const presetId = query.get('preset');
	const artifactOutputId = query.get('output') || undefined;
	const viewName = query.get('view');
	const functionName = query.get('function') ?? undefined;
	const requiresOutputSelection = artifactKind
		? artifactDefinitions[artifactKind].requiresOutputSelection === true
		: false;
	if (
		!rawSource ||
		!variantId ||
		!artifactKind ||
		!presetId ||
		requiresOutputSelection !== Boolean(artifactOutputId) ||
		(viewName !== null && viewName !== 'normalized')
	) {
		return undefined;
	}
	const source = Uri.parse(rawSource);
	if (source.scheme !== 'file') {
		return undefined;
	}
	const view: ArtifactViewOptions = {
		...(viewName === 'normalized' ? { normalized: true } : {}),
		...(functionName !== undefined ? { functionName } : {}),
	};
	if (hasView(view) && artifactDefinitions[artifactKind].presentation !== 'text') {
		return undefined;
	}
	return {
		source,
		variantId,
		artifactKind,
		presetId,
		...(artifactOutputId ? { artifactOutputId } : {}),
		...(hasView(view) ? { view } : {}),
	};
}

/** Whether the options select a view of the listing. */
export function hasView(view: ArtifactViewOptions | undefined): boolean {
	return Boolean(view?.normalized || view?.functionName !== undefined);
}
