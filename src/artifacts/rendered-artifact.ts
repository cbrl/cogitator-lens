import type {
	RawArtifact,
	RenderedArtifact,
	RenderedArtifactLine,
} from '../types/index.js';

export function renderedArtifact(
	raw: RawArtifact,
	lines: readonly RenderedArtifactLine[],
	metrics: Readonly<Record<string, unknown>> = {},
): RenderedArtifact {
	return {
		kind: raw.kind,
		lines,
		sourceLocations: lines.flatMap((line, lineIndex) => {
			const sourceLine = line.source?.line;
			return line.source?.file && sourceLine !== undefined && sourceLine !== null
				? [{
					line: lineIndex,
					uri: line.source.file,
					sourceLine,
				}]
				: [];
		}),
		links: [],
		folds: [],
		symbols: [],
		metrics,
		raw,
		truncated: raw.truncated || lines.some(line =>
			line.text.includes('[truncated; too many lines]')),
	};
}
