import { Uri } from 'vscode';
import path from 'path';
import type { RenderedArtifactLine, RenderedTextArtifact } from '../types/index.js';
import { sourceUriMap, UriMap } from '../uri-containers.js';

/**
 * Maps each source file that an artifact references to its zero-based source lines,
 * and each source line to the artifact lines generated from it.
 */
export type SourceLineMap = UriMap<Map<number, number[]>>;

export function lineHasSource(line: RenderedArtifactLine): boolean {
	// eslint-disable-next-line eqeqeq
	return line.source?.file != null && line.source?.line != null;
}

export function buildSourceLineMap(artifact: RenderedTextArtifact): SourceLineMap {
	const sourceLines: SourceLineMap = sourceUriMap();
	artifact.lines.forEach((line, index) => {
		if (!lineHasSource(line)) {
			return;
		}

		const sourceUri = Uri.file(path.normalize(line.source!.file!));
		const sourceLine = line.source!.line! - 1;

		let lineMap = sourceLines.get(sourceUri);
		if (!lineMap) {
			lineMap = new Map();
			sourceLines.set(sourceUri, lineMap);
		}
		const artifactLines = lineMap.get(sourceLine) ?? [];
		artifactLines.push(index);
		lineMap.set(sourceLine, artifactLines);
	});
	return sourceLines;
}
