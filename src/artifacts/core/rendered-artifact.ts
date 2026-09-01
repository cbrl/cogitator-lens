import type {
	RawArtifact,
	RenderedArtifactMetric,
	RenderedArtifactLine,
	RenderedTextArtifact,
} from '../../types/index.js';
import { invocationDetails } from '../../types/index.js';

export function renderedArtifact(
	raw: RawArtifact,
	lines: readonly RenderedArtifactLine[],
	metrics: Readonly<Record<string, RenderedArtifactMetric>> = {},
): RenderedTextArtifact {
	return {
		kind: raw.kind,
		...(raw.artifactDialect ? { artifactDialect: raw.artifactDialect } : {}),
		presentation: 'text',
		diagnostics: raw.diagnostics,
		durationMs: raw.durationMs,
		generatedAt: raw.generatedAt,
		command: invocationDetails(raw.command),
		lines,
		sourceLocations: lines.flatMap((line, lineIndex) => {
			const sourceLine = line.source?.line;
			return line.source?.file && sourceLine !== undefined && sourceLine !== null
				? [
						{
							line: lineIndex,
							uri: line.source.file,
							sourceLine,
						},
					]
				: [];
		}),
		links: [],
		folds: [],
		symbols: [],
		metrics,
		raw: raw.text,
		text: raw.text,
		toolOutputTruncated: raw.truncated,
		truncated: raw.truncated || lines.some((line) => line.text.includes('[truncated; too many lines]')),
	};
}
