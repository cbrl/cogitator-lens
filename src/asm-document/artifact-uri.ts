import { Uri } from 'vscode';
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
	if (source.scheme !== 'file') {
		throw new Error('Artifact documents require a file-backed source');
	}
	if (!presetId) {
		throw new Error('An artifact preset identifier is required');
	}
	const query = new URLSearchParams({
		source: source.toString(),
		variant: variant.id,
		artifact: artifactKind,
		preset: presetId,
	});
	return source.with({
		scheme: artifactScheme,
		path: replaceExtension(source.path, artifactDefinitions[artifactKind].filenameExtension),
		query: query.toString(),
		fragment: '',
	});
}

export function parseArtifactUri(uri: Uri): ArtifactUriIdentity | undefined {
	if (uri.scheme !== artifactScheme) {
		return undefined;
	}
	const query = new URLSearchParams(uri.query);
	const source = query.get('source');
	const variantId = query.get('variant');
	const artifactKind = query.get('artifact');
	const presetId = query.get('preset');
	if (
		!source
		|| !variantId
		|| !artifactKind
		|| !getArtifactDefinition(artifactKind)
		|| !presetId
	) {
		return undefined;
	}
	try {
		const identity = {
			source: Uri.parse(source),
			variantId,
			artifactKind: artifactKind as ArtifactKind,
			presetId,
		};
		if (identity.source.scheme !== 'file') {
			return undefined;
		}
		const canonical = getArtifactUri(
			identity.source,
			{ id: identity.variantId },
			identity.artifactKind,
			identity.presetId,
		);
		if (
			uri.authority !== canonical.authority
			|| uri.path !== canonical.path
			|| uri.query !== canonical.query
			|| uri.fragment !== ''
		) {
			return undefined;
		}
		return identity;
	} catch {
		return undefined;
	}
}
