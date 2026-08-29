import path from 'path';
import type {
	ArtifactLineAnnotation,
	RawArtifact,
	RenderedArtifactMetric,
	RenderedTextArtifact,
	RenderedArtifactLine,
} from '../../types/index.js';
import type { ArtifactRenderContext } from '../core/artifact-definitions.js';
import { renderedArtifact } from '../core/rendered-artifact.js';

export interface SourceAnalysisEntry {
	readonly sourceUri?: string;
	readonly sourceLine?: number;
	readonly sourceColumn?: number;
	readonly annotation: ArtifactLineAnnotation;
}

export interface AnalysisParserDiagnostic {
	readonly line: number;
	readonly message: string;
	readonly text: string;
}

export interface AnalysisSourceRenderOptions {
	readonly metrics?: Readonly<Record<string, RenderedArtifactMetric>>;
	readonly preamble?: readonly string[];
	readonly includeUnmappedEntries?: boolean;
	readonly parserDiagnostics?: readonly AnalysisParserDiagnostic[];
}

/**
 * Merges location-bearing analysis records with the primary source. Each
 * annotation receives its own empty anchor row so VS Code can inject styled
 * text above the corresponding source line without changing the source text.
 */
export function renderAnalysisSource(
	raw: RawArtifact,
	context: ArtifactRenderContext,
	entries: readonly SourceAnalysisEntry[],
	options: AnalysisSourceRenderOptions = {},
): RenderedTextArtifact {
	const sourceFile = path.normalize(context.source.uri.fsPath);
	const sourceLines = splitSourceLines(context.source.text);
	const entriesByLine = new Map<number, SourceAnalysisEntry[]>();
	const unmapped: SourceAnalysisEntry[] = [];

	for (const entry of entries) {
		if (
			entry.sourceUri !== undefined
			&& entry.sourceLine !== undefined
			&& entry.sourceLine >= 1
			&& entry.sourceLine <= sourceLines.length
			&& sameSourcePath(entry.sourceUri, sourceFile)
		) {
			const lineEntries = entriesByLine.get(entry.sourceLine) ?? [];
			lineEntries.push(entry);
			entriesByLine.set(entry.sourceLine, lineEntries);
		} else {
			unmapped.push(entry);
		}
	}

	const lines: RenderedArtifactLine[] = [
		...(options.preamble ?? []).map(text => ({ text })),
	];
	if (options.preamble?.length) {
		lines.push({ text: '' });
	}

	for (const [index, text] of sourceLines.entries()) {
		const sourceLine = index + 1;
		const source = {
			file: sourceFile,
			line: sourceLine,
			column: 0,
			mainSource: true,
		} as const;
		for (const entry of entriesByLine.get(sourceLine) ?? []) {
			lines.push({
				text: '',
				source: {
					...source,
					column: clampColumn(entry.sourceColumn, text.length),
				},
				annotations: [entry.annotation],
			});
		}
		lines.push({ text, source });
	}

	if (options.includeUnmappedEntries && unmapped.length > 0) {
		lines.push(
			{ text: '' },
			{ text: 'Unmapped entries' },
			...unmapped.map(entry => ({
				text: formatArtifactLineAnnotation(entry.annotation),
			})),
		);
	}

	const parserDiagnostics = options.parserDiagnostics ?? [];
	if (parserDiagnostics.length > 0) {
		lines.push(
			{ text: '' },
			{ text: 'Parser diagnostics' },
			...parserDiagnostics.map(diagnostic => ({
				text: `line ${diagnostic.line}: ${diagnostic.message} — ${diagnostic.text}`,
			})),
		);
	}

	return renderedArtifact(raw, lines, options.metrics);
}

export function formatArtifactLineAnnotation(annotation: ArtifactLineAnnotation): string {
	switch (annotation.kind) {
		case 'optimization-remark':
			return `[${annotation.category}] ${annotation.message}`;
		case 'stack-usage': {
			const unit = annotation.unit === 'vm-slots'
				? `VM slot${annotation.value === 1 ? '' : 's'}`
				: `byte${annotation.value === 1 ? '' : 's'}`;
			const qualifier = annotation.qualifier === 'vm'
				? ''
				: `, ${annotation.qualifier}`;
			return `stack: ${annotation.value} ${unit}${qualifier} — ${annotation.functionName}`;
		}
	}
}

function clampColumn(column: number | undefined, lineLength: number): number {
	return Math.max(0, Math.min(lineLength, (column ?? 1) - 1));
}

function splitSourceLines(text: string): string[] {
	return text.split(/\r\n|\n|\r/);
}

export function sameSourcePath(left: string, right: string): boolean {
	const normalizedLeft = path.resolve(left);
	const normalizedRight = path.resolve(right);
	return process.platform === 'win32'
		? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
		: normalizedLeft === normalizedRight;
}
