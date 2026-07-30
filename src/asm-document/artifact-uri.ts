import { Uri } from 'vscode';
import path from 'path';
import type {
	ArtifactKind,
	CompilationVariant,
} from '../types/index.js';
import {
	artifactDefinitions,
	getArtifactDefinition,
} from '../artifacts/artifact-definitions.js';
import { replaceExtension } from '../utils.js';

export const artifactScheme = 'coglens-artifact';

export interface ArtifactUriIdentity {
	readonly source: Uri;
	readonly variantId: string;
	readonly artifactKind: ArtifactKind;
	readonly presetId: string;
}

export function getArtifactUri(
	source: Uri,
	variant: Pick<CompilationVariant, 'id'>,
	artifactKind: ArtifactKind,
	presetId: string,
): Uri {
	const query = new URLSearchParams({
		source: source.toString(),
		variant: variant.id,
		artifact: artifactKind,
		preset: presetId,
	});
	return source.with({
		scheme: artifactScheme,
		path: artifactPath(source.path, artifactKind),
		query: query.toString(),
		fragment: '',
	});
}

function artifactPath(sourcePath: string, artifactKind: ArtifactKind): string {
	const definition = artifactDefinitions[artifactKind];
	const sourceExtension = definition.documentLanguage === 'source'
		? path.extname(sourcePath)
		: '';
	return replaceExtension(
		sourcePath,
		`${definition.filenameExtension}${sourceExtension}`,
	);
}

export function parseArtifactUri(uri: Uri): ArtifactUriIdentity | undefined {
	if (uri.scheme !== artifactScheme) {
		return undefined;
	}
	const query = new URLSearchParams(uri.query);
	const rawSource = query.get('source');
	const variantId = query.get('variant');
	const artifactKind = query.get('artifact');
	const presetId = query.get('preset');
	if (
		!rawSource
		|| !variantId
		|| !artifactKind
		|| !getArtifactDefinition(artifactKind)
		|| !presetId
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
		artifactKind: artifactKind as ArtifactKind,
		presetId,
	};
}
