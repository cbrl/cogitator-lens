import { Uri } from 'vscode';
import path from 'path';
import type { ArtifactKind, RenderedArtifactLine } from '../types/index.js';
import { sourceUriMap, sourceUriSet, UriMap, UriSet } from '../uri-containers.js';

/**
 * The compiled assembly for a source document: its rendered lines, the set of
 * all source documents it references, and the source-line -> assembly-line
 * mapping used to highlight and dim lines in each direction.
 */
export interface ArtifactDocumentContent {
	readonly kind: ArtifactKind;
	readonly sourceUri: Uri;
	readonly artifactUri: Uri;
	readonly lines: readonly RenderedArtifactLine[];
	readonly allReferencedSrcUris: UriSet;
	readonly sourceLineMappings: UriMap<Map<number, number[]>>;
}

export function asmLineHasSource(line: RenderedArtifactLine): boolean {
	// eslint-disable-next-line eqeqeq
	return line.source?.file != null && line.source?.line != null;
}

export function getContent(assembly: ArtifactDocumentContent): string {
	return assembly.lines.map((line) => line.text).join('\n');
}

export function buildArtifactDocumentContent(
	sourceUri: Uri,
	artifactUri: Uri,
	kind: ArtifactKind,
	lines: readonly RenderedArtifactLine[],
): ArtifactDocumentContent {
	const allReferencedSrcUris = sourceUriSet();
	const sourceLineMappings = sourceUriMap<Map<number, number[]>>();

	lines.forEach((line, index) => {
		if (!asmLineHasSource(line)) {
			return;
		}

		const sourceUri = Uri.file(path.normalize(line.source!.file!));
		const sourceLine = line.source!.line! - 1;

		allReferencedSrcUris.add(sourceUri);

		let lineMap = sourceLineMappings.get(sourceUri);
		if (!lineMap) {
			lineMap = new Map();
			sourceLineMappings.set(sourceUri, lineMap);
		}
		const asmLines = lineMap.get(sourceLine) ?? [];
		asmLines.push(index);
		lineMap.set(sourceLine, asmLines);
	});

	return { kind, sourceUri, artifactUri, lines, allReferencedSrcUris, sourceLineMappings };
}
