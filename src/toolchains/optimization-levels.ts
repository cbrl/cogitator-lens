/** One optimization level that the status menu offers. */
export interface OptimizationLevel {
	readonly label: string;
	/** The arguments that select the level. They go after the variant and preset arguments. */
	readonly arguments: readonly string[];
	/** Other single arguments that select the same level, such as `-O` for `-O1`. */
	readonly aliases?: readonly string[];
	/**
	 * The prefixes of the arguments that the compiler rejects together with this level. When the
	 * preset or the edit selects the level, Cogitator Lens removes these arguments.
	 */
	readonly conflictingPrefixes?: readonly string[];
}

type LevelExtras = Pick<OptimizationLevel, 'aliases' | 'conflictingPrefixes'>;

function singleArgumentLevels(
	flags: readonly string[],
	extras: Readonly<Record<string, LevelExtras>> = {},
): readonly OptimizationLevel[] {
	return Object.freeze(
		flags.map((flag) => Object.freeze({ label: flag, arguments: Object.freeze([flag]), ...extras[flag] })),
	);
}

/** GCC and Clang read `-O` as `-O1`. */
const plainO: Readonly<Record<string, LevelExtras>> = { '-O1': { aliases: ['-O'] } };
export const gccOptimizationLevels = singleArgumentLevels(['-O0', '-O1', '-O2', '-O3', '-Os', '-Og'], plainO);
export const clangOptimizationLevels = singleArgumentLevels(['-O0', '-O1', '-O2', '-O3', '-Os', '-Oz'], plainO);
/**
 * cl.exe also reads `-O2` as `/O2`. It stops with error D8016 when a `/RTC` check comes with `/O1`,
 * `/O2`, or `/Ox`. CMake adds `/RTC1` to a Debug configuration, so these levels remove the checks.
 */
const runtimeChecks = Object.freeze(['/RTC', '-RTC']);
export const msvcOptimizationLevels = singleArgumentLevels(['/Od', '/O1', '/O2', '/Ox'], {
	'/Od': { aliases: ['-Od'] },
	'/O1': { aliases: ['-O1'], conflictingPrefixes: runtimeChecks },
	'/O2': { aliases: ['-O2'], conflictingPrefixes: runtimeChecks },
	'/Ox': { aliases: ['-Ox'], conflictingPrefixes: runtimeChecks },
});
/** rustc uses the last `-O` or `-C opt-level`, so a level that follows the variant arguments replaces theirs. */
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
				(candidate.arguments.length > 1 && args[index] === candidate.arguments.join('')) ||
				candidate.aliases?.includes(args[index]),
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

/**
 * Removes the arguments that the compiler rejects with the level that the added arguments select.
 * The added arguments are the preset and the edited arguments. A level in the base arguments removes
 * nothing, so a variant keeps the arguments that its author wrote.
 */
export function withoutLevelConflicts(
	base: readonly string[],
	added: readonly string[],
	levels: readonly OptimizationLevel[] | undefined,
): { readonly base: readonly string[]; readonly added: readonly string[] } {
	const prefixes = levels && selectedOptimizationLevel(added, levels)?.conflictingPrefixes;
	if (!prefixes?.length) {
		return { base, added };
	}
	const keep = (argument: string): boolean => !prefixes.some((prefix) => argument.startsWith(prefix));
	return { base: base.filter(keep), added: added.filter(keep) };
}
