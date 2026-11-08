import { Uri } from 'vscode';
import path from 'path';
import type { RenderedTextArtifact } from '../types/index.js';
import { SourceUriMap } from '../file-identity.js';
import { lineHasSource } from './line-shift.js';

/**
 * Maps each source file that an artifact references to its zero-based source lines,
 * and each source line to the artifact lines generated from it.
 */
export type SourceLineMap = SourceUriMap<Map<number, number[]>>;

export function buildSourceLineMap(artifact: RenderedTextArtifact): SourceLineMap {
	const sourceLines: SourceLineMap = new SourceUriMap();
	// The key of a source file can read the file system, and a listing names a few files on many
	// lines, so each name of a file finds its line map once.
	const lineMaps = new Map<string, Map<number, number[]>>();
	artifact.lines.forEach((line, index) => {
		if (!lineHasSource(line)) {
			return;
		}

		const sourceLine = line.source.line - 1;
		let lineMap = lineMaps.get(line.source.file);
		if (!lineMap) {
			const sourceUri = Uri.file(path.normalize(line.source.file));
			lineMap = sourceLines.get(sourceUri);
			if (!lineMap) {
				lineMap = new Map();
				sourceLines.set(sourceUri, lineMap);
			}
			lineMaps.set(line.source.file, lineMap);
		}
		const artifactLines = lineMap.get(sourceLine) ?? [];
		artifactLines.push(index);
		lineMap.set(sourceLine, artifactLines);
	});
	return sourceLines;
}
