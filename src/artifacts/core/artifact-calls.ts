import type { ArtifactLink, RenderedTextArtifact } from '../../types/index.js';
import { functionRanges, type FunctionRange } from './artifact-views.js';

/** The links from one function to another. */
export interface FunctionCall {
	readonly caller: FunctionRange;
	readonly callee: FunctionRange;
	/** The links in the caller that go to the callee. */
	readonly links: readonly ArtifactLink[];
}

/** The function that holds a line, or nothing for a line outside each function. */
export function functionAt(ranges: readonly FunctionRange[], line: number): FunctionRange | undefined {
	return ranges.find((range) => line >= range.startLine && line <= range.endLine);
}

/**
 * The calls between the functions of one listing. A link calls a function when it goes from one
 * function to the first line of another. The listing holds one translation unit, so a call to a
 * function in another file has no link.
 */
export function functionCalls(artifact: RenderedTextArtifact): FunctionCall[] {
	const ranges = functionRanges(artifact);
	const byStartLine = new Map(ranges.map((range) => [range.startLine, range]));
	const calls = new Map<string, { caller: FunctionRange; callee: FunctionRange; links: ArtifactLink[] }>();
	for (const link of artifact.links) {
		const callee = byStartLine.get(link.targetLine);
		const caller = functionAt(ranges, link.line);
		if (!callee || !caller || caller === callee) {
			continue;
		}
		const key = `${caller.startLine}:${callee.startLine}`;
		const call = calls.get(key) ?? { caller, callee, links: [] };
		call.links.push(link);
		calls.set(key, call);
	}
	return [...calls.values()];
}

/** The links that go to a line, which are the references to the label or the value on it. */
export function linksTo(artifact: RenderedTextArtifact, targetLine: number): ArtifactLink[] {
	return artifact.links.filter((link) => link.targetLine === targetLine);
}

/** The link at a position, or nothing. */
export function linkAt(artifact: RenderedTextArtifact, line: number, character: number): ArtifactLink | undefined {
	return artifact.links.find(
		(link) => link.line === line && character >= link.startCharacter && character <= link.endCharacter,
	);
}
