import type {
	RawArtifact,
	RenderedArtifactMetric,
	RenderedArtifactLine,
	RenderedTextArtifact,
} from '../../types/index.js';

export function renderedArtifact(
	raw: RawArtifact,
	lines: readonly RenderedArtifactLine[],
	metrics: Readonly<Record<string, RenderedArtifactMetric>> = {},
): RenderedTextArtifact {
	return {
		kind: raw.kind,
		presentation: 'text',
		diagnostics: raw.diagnostics,
		durationMs: raw.durationMs,
		generatedAt: raw.generatedAt,
		command: raw.command,
		lines,
		links: [],
		folds: [],
		symbols: [],
		metrics,
		truncated: lines.some((line) => line.text.includes('[truncated; too many lines]')),
	};
}
