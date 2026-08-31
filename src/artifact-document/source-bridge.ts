/** Pure source/artifact mapping helpers used by editor decorations and scroll linking. */

export interface SourceLocationLine {
	readonly source?: {
		readonly file: string | null;
		readonly line: number | null;
	} | null;
}

export interface SourceScrollAnchor {
	readonly sourceLine: number;
	readonly artifactLine: number;
}

export interface ArtifactScrollAnchor {
	readonly file: string;
	readonly sourceLine: number;
	readonly artifactLine: number;
}

/**
 * Suppresses the visible-range events produced by a programmatic scroll until
 * the target editor has stopped moving. VS Code can emit several such events
 * for one reveal when smooth scrolling is enabled.
 */
export class ScrollSyncSuppression<T> {
	private target?: T;
	private release?: ReturnType<typeof setTimeout>;

	public constructor(
		private readonly settleDelay = 150,
		private readonly initialDelay = 500,
	) {}

	public begin(target: T): void {
		this.target = target;
		this.scheduleRelease(this.initialDelay);
	}

	public shouldSuppress(candidate: T): boolean {
		if (candidate !== this.target) {
			return false;
		}
		this.scheduleRelease(this.settleDelay);
		return true;
	}

	public dispose(): void {
		if (this.release !== undefined) {
			clearTimeout(this.release);
		}
		this.release = undefined;
		this.target = undefined;
	}

	private scheduleRelease(delay: number): void {
		if (this.release !== undefined) {
			clearTimeout(this.release);
		}
		this.release = setTimeout(() => {
			this.release = undefined;
			this.target = undefined;
		}, delay);
	}
}

/**
 * Finds the first mapped source line in the visible interval and the first
 * generated line associated with it. Map iteration order is deliberately not
 * significant: renderers can construct mappings in any order.
 */
export function sourceScrollAnchor(
	mapping: ReadonlyMap<number, readonly number[]>,
	visibleStart: number,
	visibleEnd: number,
): SourceScrollAnchor | undefined {
	let anchor: SourceScrollAnchor | undefined;
	for (const [sourceLine, artifactLines] of mapping) {
		if (sourceLine < visibleStart || sourceLine > visibleEnd) {
			continue;
		}
		const artifactLine = artifactLines.reduce<number | undefined>(
			(lowest, candidate) => candidate >= 0 && (lowest === undefined || candidate < lowest)
				? candidate
				: lowest,
			undefined,
		);
		if (
			artifactLine !== undefined
			&& (
				anchor === undefined
				|| sourceLine < anchor.sourceLine
				|| (sourceLine === anchor.sourceLine && artifactLine < anchor.artifactLine)
			)
		) {
			anchor = { sourceLine, artifactLine };
		}
	}
	return anchor;
}

/** Finds the first generated line in the visible interval with a source location. */
export function artifactScrollAnchor(
	lines: readonly SourceLocationLine[],
	visibleStart: number,
	visibleEnd: number,
): ArtifactScrollAnchor | undefined {
	const start = Math.max(0, visibleStart);
	const end = Math.min(visibleEnd, lines.length - 1);
	for (let artifactLine = start; artifactLine <= end; artifactLine++) {
		const source = lines[artifactLine]?.source;
		if (source?.file && source.line !== null && source.line !== undefined && source.line > 0) {
			return {
				file: source.file,
				sourceLine: source.line - 1,
				artifactLine,
			};
		}
	}
	return undefined;
}

/** Maps a positive output-line count onto a zero-based, linear heat level. */
export function sourceDensityLevel(count: number, maximum: number, levelCount: number): number {
	if (count <= 0 || maximum <= 0 || levelCount <= 0) {
		return 0;
	}
	return Math.min(levelCount - 1, Math.ceil((count / maximum) * levelCount) - 1);
}

/** Selects the repeating source-line color band used by mapping decorations. */
export function sourceLineBandIndex(sourceLine: number, bandCount: number): number {
	if (bandCount <= 0) {
		return 0;
	}
	return ((sourceLine % bandCount) + bandCount) % bandCount;
}
