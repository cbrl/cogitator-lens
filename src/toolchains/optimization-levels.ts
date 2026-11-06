/** One optimization level that the status menu offers. */
export interface OptimizationLevel {
	readonly label: string;
	/** The arguments that select the level. They go after the variant and preset arguments. */
	readonly arguments: readonly string[];
}

function singleArgumentLevels(flags: readonly string[]): readonly OptimizationLevel[] {
	return Object.freeze(flags.map((flag) => Object.freeze({ label: flag, arguments: Object.freeze([flag]) })));
}

export const gccOptimizationLevels = singleArgumentLevels(['-O0', '-O1', '-O2', '-O3', '-Os', '-Og']);
export const clangOptimizationLevels = singleArgumentLevels(['-O0', '-O1', '-O2', '-O3', '-Os', '-Oz']);
export const msvcOptimizationLevels = singleArgumentLevels(['/Od', '/O1', '/O2', '/Ox']);
/** rustc uses the last `-C opt-level`, so a level that follows the variant arguments replaces theirs. */
export const rustOptimizationLevels: readonly OptimizationLevel[] = Object.freeze(
	['0', '1', '2', '3', 's', 'z'].map((level) =>
		Object.freeze({ label: `opt-level=${level}`, arguments: Object.freeze(['-C', `opt-level=${level}`]) }),
	),
);
export const zigOptimizationLevels: readonly OptimizationLevel[] = Object.freeze(
	['Debug', 'ReleaseSafe', 'ReleaseFast', 'ReleaseSmall'].map((mode) =>
		Object.freeze({ label: mode, arguments: Object.freeze(['-O', mode]) }),
	),
);
export const pythonOptimizationLevels = singleArgumentLevels(['-O', '-OO']);
export const dotnetOptimizationLevels = singleArgumentLevels(['-optimize-', '-optimize+']);

/** The position and length of each level in the arguments. A level can also be one joined argument. */
function levelMatches(
	args: readonly string[],
	levels: readonly OptimizationLevel[],
): Array<{ readonly index: number; readonly length: number; readonly level: OptimizationLevel }> {
	const matches: Array<{ index: number; length: number; level: OptimizationLevel }> = [];
	for (let index = 0; index < args.length; index++) {
		const level = levels.find(
			(candidate) =>
				candidate.arguments.every((argument, offset) => args[index + offset] === argument) ||
				(candidate.arguments.length > 1 && args[index] === candidate.arguments.join('')),
		);
		if (level) {
			const length = level.arguments.every((argument, offset) => args[index + offset] === argument)
				? level.arguments.length
				: 1;
			matches.push({ index, length, level });
			index += length - 1;
		}
	}
	return matches;
}

/** The level that the arguments select. The compiler uses the last one. */
export function selectedOptimizationLevel(
	args: readonly string[],
	levels: readonly OptimizationLevel[],
): OptimizationLevel | undefined {
	return levelMatches(args, levels).at(-1)?.level;
}

/** Replaces each level in the arguments with the given level, or removes them without one. */
export function withOptimizationLevel(
	args: readonly string[],
	levels: readonly OptimizationLevel[],
	level: OptimizationLevel | undefined,
): string[] {
	const removed = new Set<number>();
	for (const match of levelMatches(args, levels)) {
		for (let offset = 0; offset < match.length; offset++) {
			removed.add(match.index + offset);
		}
	}
	return [...args.filter((_argument, index) => !removed.has(index)), ...(level?.arguments ?? [])];
}
