/** A position in a text: a zero-based line and character. */
export interface TextPosition {
	readonly line: number;
	readonly character: number;
}

/**
 * One text change, as VS Code reports it: the range of the old text that the new text replaces.
 * The changes of one event apply in their order, and each range refers to the text after the
 * changes before it.
 */
export interface LineChange {
	readonly range: { readonly start: TextPosition; readonly end: TextPosition };
	readonly text: string;
}

/**
 * The line that an old line moves to after a change, or nothing when the change removes it. A line
 * moves with its start. A change that starts after the start of the line keeps the line in place,
 * and the line keeps what is left of its text. A change that starts at the start of the line moves
 * the rest of the line after the new text.
 */
export function shiftedLine(line: number, change: LineChange): number | undefined {
	const { start, end } = change.range;
	const added = lineBreaks(change.text);
	if (line < start.line) {
		return line;
	}
	if (line > end.line) {
		return line + added - (end.line - start.line);
	}
	if (line === start.line) {
		if (start.character > 0) {
			return line;
		}
		// The change removes the whole line and its line break when it ends on a later line.
		return end.line === start.line ? start.line + added : undefined;
	}
	// The start of a later line in the range is removed, unless the range ends just before it.
	return line === end.line && end.character === 0 ? start.line + added : undefined;
}

function lineBreaks(text: string): number {
	return text.match(/\r\n|\r|\n/g)?.length ?? 0;
}

/**
 * Moves lines of an older text to their lines in a newer text, through the changes between the
 * two texts. Only the lines that it was made with are known.
 */
export class LineShift {
	private readonly current = new Map<number, number | undefined>();
	private moved = false;

	constructor(lines: Iterable<number>) {
		for (const line of lines) {
			this.current.set(line, line);
		}
	}

	/** Whether each known line is still on its line. */
	get isIdentity(): boolean {
		return !this.moved;
	}

	/** Applies the changes of one event. */
	apply(changes: readonly LineChange[]): void {
		for (const change of changes) {
			for (const [line, now] of this.current) {
				if (now === undefined) {
					continue;
				}
				const next = shiftedLine(now, change);
				if (next !== now) {
					this.moved = true;
					this.current.set(line, next);
				}
			}
		}
	}

	/** The line in the newer text, or nothing when a change removed the line or the line is not known. */
	lineOf(line: number): number | undefined {
		return this.current.get(line);
	}
}
