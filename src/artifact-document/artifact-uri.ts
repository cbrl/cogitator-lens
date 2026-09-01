import { Uri } from 'vscode';
import path from 'path';
import type { ArtifactKind, CompilationVariant } from '../types/index.js';
import { artifactDefinitions, getArtifactKind } from '../artifacts/core/artifact-definitions.js';
import { replaceExtension } from '../utils.js';

export const artifactScheme = 'coglens-artifact';

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
	if (artifactKind === 'control-flow-graph' && !artifactOutputId) {
		throw new Error('Control-flow graph URIs require an output selection.');
	}
	if (artifactKind !== 'control-flow-graph' && artifactOutputId) {
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

function artifactPath(sourcePath: string, artifactKind: ArtifactKind): string {
	const definition = artifactDefinitions[artifactKind];
	const sourceExtension = definition.documentLanguage === 'source' ? path.extname(sourcePath) : '';
	return replaceExtension(sourcePath, `${definition.filenameExtension}${sourceExtension}`);
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
	if (
		!rawSource ||
		!variantId ||
		!artifactKind ||
		!presetId ||
		(artifactKind === 'control-flow-graph') !== Boolean(artifactOutputId)
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
