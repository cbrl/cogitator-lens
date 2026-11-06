import { sameLocalFileTest } from '../../file-identity.js';
import type { RenderedArtifactLine, RenderedTextArtifact } from '../../types/index.js';
import { functionRanges } from './artifact-views.js';

/** One function of a listing and the first line of the source that it comes from. */
export interface FunctionSummary {
	readonly name: string;
	/** The zero-based line of the function symbol in the listing. */
	readonly artifactLine: number;
	/** The zero-based first line of the source file that the function lines come from. */
	readonly sourceLine: number;
	/** The lines of the function that are instructions: lines with code bytes or a source line. */
	readonly instructionCount: number;
}

function isInstruction(line: RenderedArtifactLine): boolean {
	// eslint-disable-next-line eqeqeq
	return Boolean(line.opcodes?.length) || (line.source?.file != null && line.source?.line != null);
}

/** The zero-based listing lines that come from one zero-based line of a source file. */
export function linesFromSource(artifact: RenderedTextArtifact, sourceFile: string, sourceLine: number): number[] {
	const isSource = sameLocalFileTest(sourceFile);
	return artifact.lines.flatMap((line, index) =>
		line.source?.file && line.source.line === sourceLine + 1 && isSource(line.source.file) ? [index] : [],
	);
}

/**
 * The functions of a listing that come from a source file. The source line is the line of the
 * first instruction from that file, which is usually the function signature. The lowest line is
 * not used, because inlined code can come from an earlier line, such as a `#[derive]` attribute.
 */
export function functionSummaries(artifact: RenderedTextArtifact, sourceFile: string): FunctionSummary[] {
	const isSource = sameLocalFileTest(sourceFile);
	return functionRanges(artifact).flatMap((range) => {
		const lines = artifact.lines.slice(range.startLine, range.endLine + 1);
		const first = lines.find((line) => line.source?.file && line.source.line && isSource(line.source.file));
		if (!first?.source?.line) {
			return [];
		}
		return [
			{
				name: range.name,
				artifactLine: range.startLine,
				sourceLine: first.source.line - 1,
				instructionCount: lines.filter(isInstruction).length,
			},
		];
	});
}

/**
 * Whether a symbol is a Windows exception handling funclet, such as `?catch$6@?0?main@4HA`. A
 * funclet is a part of its parent function, not a function of its own.
 */
export function isExceptionFunclet(name: string): boolean {
	return /^\?(?:catch|dtor|filt|fin)\$\d+@/.test(name);
}

/**
 * The text of some listing lines for a preview. A gap between lines shows as `…`, and the lines
 * past the limit show as a count.
 */
export function previewText(artifact: RenderedTextArtifact, lineNumbers: readonly number[], limit: number): string {
	const shown = lineNumbers.slice(0, limit);
	const parts: string[] = [];
	shown.forEach((lineNumber, index) => {
		if (index > 0 && lineNumber !== shown[index - 1] + 1) {
			parts.push('…');
		}
		parts.push(artifact.lines[lineNumber]?.text ?? '');
	});
	if (lineNumbers.length > limit) {
		const more = lineNumbers.length - limit;
		parts.push(`… ${more} more line${more === 1 ? '' : 's'}`);
	}
	return parts.join('\n');
}
