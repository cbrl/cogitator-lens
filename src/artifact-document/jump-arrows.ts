import type { ArtifactLink } from '../types/index.js';

export type JumpArrowDirection = 'forward' | 'backward';

export interface JumpArrow {
	readonly sourceLine: number;
	readonly targetLine: number;
	readonly direction: JumpArrowDirection;
}

/**
 * Converts navigable label references into the ordered edges drawn beside a
 * text artifact. A self-edge is treated as a back edge because it is a loop.
 * Invalid renderer positions are ignored before they reach VS Code ranges.
 */
export function jumpArrows(links: readonly ArtifactLink[], lineCount: number): readonly JumpArrow[] {
	const arrows = new Map<string, JumpArrow>();
	for (const link of links) {
		if (
			(link.edgeKind !== 'unconditional' && link.edgeKind !== 'true') ||
			!validLine(link.line, lineCount) ||
			!validLine(link.targetLine, lineCount)
		) {
			continue;
		}
		const arrow: JumpArrow = {
			sourceLine: link.line,
			targetLine: link.targetLine,
			direction: link.targetLine <= link.line ? 'backward' : 'forward',
		};
		arrows.set(`${arrow.sourceLine}:${arrow.targetLine}`, arrow);
	}
	return [...arrows.values()].sort(
		(left, right) => left.sourceLine - right.sourceLine || left.targetLine - right.targetLine,
	);
}

function validLine(line: number, lineCount: number): boolean {
	return Number.isInteger(line) && line >= 0 && line < lineCount;
}
