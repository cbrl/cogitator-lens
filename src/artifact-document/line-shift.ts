import type { RenderedArtifactLine, RenderedArtifactLineSource, RenderedTextArtifact } from '../types/index.js';

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

/**
 * The first character of a line that a change can move to a different column, or nothing when
 * each character of the line keeps its column. The characters before it keep their columns. Use
 * it only for a line that the change does not remove.
 */
export function changedCharacter(line: number, change: LineChange): number | undefined {
	const { start, end } = change.range;
	if (line < start.line || line > end.line) {
		return undefined;
	}
	if (line === start.line && start.character > 0) {
		return start.character;
	}
	// A change that ends at the start of the line puts the end of its new text before the line.
	return line === end.line && end.character === 0 && columnAfter(change) === 0 ? undefined : 0;
}

function lineBreaks(text: string): number {
	return text.match(/\r\n|\r|\n/g)?.length ?? 0;
}

/** The column after the new text of a change. */
function columnAfter(change: LineChange): number {
	const { text } = change;
	const lastBreak = Math.max(text.lastIndexOf('\n'), text.lastIndexOf('\r'));
	return lastBreak >= 0 ? text.length - lastBreak - 1 : change.range.start.character + text.length;
}

/**
 * Moves lines of an older text to their lines in a newer text, through the changes between the
 * two texts. Only the lines that it was made with are known.
 */
export class LineShift {
	private readonly current = new Map<number, number | undefined>();
	/** The first character of each known line that a change moved to a different column. */
	private readonly changedFrom = new Map<number, number>();
	private moved = false;

	constructor(lines: Iterable<number>) {
		for (const line of lines) {
			this.current.set(line, line);
		}
	}

	/** Whether each known line is still on its line, and each of its characters at its column. */
	get isIdentity(): boolean {
		return !this.moved && this.changedFrom.size === 0;
	}

	/** Applies the changes of one event. */
	apply(changes: readonly LineChange[]): void {
		for (const change of changes) {
			for (const [line, now] of this.current) {
				if (now === undefined) {
					continue;
				}
				const next = shiftedLine(now, change);
				const character = next === undefined ? undefined : changedCharacter(now, change);
				if (character !== undefined) {
					this.changedFrom.set(line, Math.min(character, this.changedFrom.get(line) ?? character));
				}
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

	/**
	 * The first character of a known line that a change moved to a different column, or nothing
	 * when each character keeps its column. The characters before it keep their columns.
	 */
	changedCharacterOf(line: number): number | undefined {
		return this.changedFrom.get(line);
	}
}

/** The changes of one event of a document, and the document version after them. */
interface VersionedChanges {
	readonly version: number;
	readonly changes: readonly LineChange[];
}

/**
 * Keeps the changes of a document by version, so a shift can start at an older version of the
 * text. It keeps a limited number of events, and it drops the oldest event first.
 */
export class ChangeLog {
	private readonly entries: VersionedChanges[] = [];

	constructor(private readonly limit: number) {}

	/**
	 * Keeps the changes of one event. VS Code also sends an event without changes when the dirty
	 * state changes, and that event has the version of the last change, so it adds nothing. A lower
	 * version comes from a new document of the file, so the log starts again.
	 */
	record(version: number, changes: readonly LineChange[]): void {
		const last = this.entries.at(-1);
		if (last !== undefined && version === last.version) {
			return;
		}
		if (last !== undefined && version < last.version) {
			this.entries.length = 0;
		}
		this.entries.push({ version, changes });
		if (this.entries.length > this.limit) {
			this.entries.shift();
		}
	}

	/**
	 * The changes of each version after a base version, up to the current version, in their order.
	 * It is nothing when the log does not have each of them. Otherwise the log drops the older
	 * changes, because a later shift starts at this base or after it.
	 */
	takeChangesAfter(base: number, current: number): (readonly LineChange[])[] | undefined {
		const later = this.entries.filter((entry) => entry.version > base);
		const complete =
			later.length === current - base && later.every((entry, index) => entry.version === base + index + 1);
		if (!complete) {
			return undefined;
		}
		this.entries.splice(0, this.entries.length - later.length);
		return later.map((entry) => entry.changes);
	}

	clear(): void {
		this.entries.length = 0;
	}
}

/** An artifact line with a source file and a source line. */
export type SourcedArtifactLine = RenderedArtifactLine & {
	readonly source: RenderedArtifactLineSource & { readonly file: string; readonly line: number };
};

export function lineHasSource(line: RenderedArtifactLine): line is SourcedArtifactLine {
	// eslint-disable-next-line eqeqeq
	return line.source?.file != null && line.source?.line != null;
}

/**
 * An artifact whose main-source lines are moved through the shift. A line whose source line an edit
 * removed has no source. A range keeps its end only when the end line still exists. A range keeps
 * its columns only when no edit moved a character of the range to a different column.
 */
export function movedArtifact(
	artifact: RenderedTextArtifact,
	shift: LineShift,
	isMainSourceFile: (file: string) => boolean,
): RenderedTextArtifact {
	return {
		...artifact,
		lines: artifact.lines.map((line): RenderedArtifactLine => {
			if (!lineHasSource(line) || !isMainSourceFile(line.source.file)) {
				return line;
			}
			const { column, endLine, endColumn, ...start } = line.source;
			const moved = shift.lineOf(start.line - 1);
			if (moved === undefined) {
				return { ...line, source: null };
			}
			const startChanged = shift.changedCharacterOf(start.line - 1);
			const keepsStart = startChanged === undefined || (column ?? 0) < startChanged;
			const end = endLine === undefined ? undefined : shift.lineOf(endLine - 1);
			const endChanged = endLine === undefined ? undefined : shift.changedCharacterOf(endLine - 1);
			const keepsEnd =
				keepsStart &&
				end !== undefined &&
				end >= moved &&
				endColumn !== undefined &&
				(endChanged === undefined || endColumn <= endChanged);
			return {
				...line,
				source: {
					...start,
					line: moved + 1,
					...(keepsStart && column !== undefined ? { column } : {}),
					...(keepsEnd ? { endLine: end + 1, endColumn } : {}),
				},
			};
		}),
	};
}
