import type { ParsedAsmResultLine } from '../../../vendor/types/asmresult/asmresult.interfaces.js';
import type { ControlFlowSourceLocation } from '../../../types/index.js';
import { compilerSourceUri } from '../cfg-parser-support.js';

/**
 * One line of assembly, carrying the two things the graph needs to stay
 * navigable: where the line came from in the artifact, and which source
 * position the compiler attributed to it.
 *
 * Compiler Explorer's equivalent (`lib/cfg/cfg-parsers/base.ts`) is
 * `{text, source?}`. The artifact index is added here because block nodes are
 * built from ranges of *filtered* lines, and without it the mapping back to the
 * rendered artifact is lost as soon as a line is dropped.
 */
export interface AssemblyLine {
	readonly text: string;
	/** Zero-based index of this line in the artifact the graph is rendered from. */
	readonly artifactLine: number;
	readonly source?: ControlFlowSourceLocation;
}

/**
 * Converts the vendored assembly parser's output into graph input.
 *
 * The parser reports `source.file === null` for the translation unit being
 * compiled, so the caller supplies that URI rather than letting each line
 * re-derive it.
 */
export function toAssemblyLines(
	asm: readonly ParsedAsmResultLine[],
	mainSourceUri: string,
	workingDirectory: string,
): AssemblyLine[] {
	return asm.map((line, index) => {
		const source = sourceLocation(line, mainSourceUri, workingDirectory);
		return {
			text: line.text,
			artifactLine: index,
			...(source ? { source } : {}),
		};
	});
}

function sourceLocation(
	line: ParsedAsmResultLine,
	mainSourceUri: string,
	workingDirectory: string,
): ControlFlowSourceLocation | undefined {
	const source = line.source;
	if (!source || source.line === null || source.line <= 0) {
		return undefined;
	}
	const uri = source.file === null ? mainSourceUri : compilerSourceUri(source.file, workingDirectory);
	return {
		uri,
		// Assembly parsers report one-based positions; editor positions are zero-based.
		line: source.line - 1,
		column: Math.max(0, (source.column ?? 1) - 1),
	};
}
