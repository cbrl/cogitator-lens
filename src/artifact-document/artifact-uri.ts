import { Uri } from 'vscode';
import path from 'path';
import type { ArtifactKind, CompilationVariant } from '../types/index.js';
import { artifactDefinitions, getArtifactKind } from '../artifacts/core/artifact-definitions.js';
import { artifactScheme } from './artifact-scheme.js';

export { artifactScheme };

export interface ArtifactUriIdentity {
	readonly source: Uri;
	readonly variantId: string;
	readonly artifactKind: ArtifactKind;
	readonly presetId: string;
	readonly artifactOutputId?: string;
}

export function getArtifactUri(
	source: Uri,
	variant: Pick<CompilationVariant, 'id'>,
	artifactKind: ArtifactKind,
	presetId: string,
	artifactOutputId?: string,
): Uri {
	const definition = artifactDefinitions[artifactKind];
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
	const requiresOutputSelection = artifactKind
		? artifactDefinitions[artifactKind].requiresOutputSelection === true
		: false;
	if (
		!rawSource ||
		!variantId ||
		!artifactKind ||
		!presetId ||
		requiresOutputSelection !== Boolean(artifactOutputId)
	) {
		return undefined;
	}
	const source = Uri.parse(rawSource);
	if (source.scheme !== 'file') {
		return undefined;
	}
	return {
		source,
		variantId,
		artifactKind,
		presetId,
		...(artifactOutputId ? { artifactOutputId } : {}),
	};
}
