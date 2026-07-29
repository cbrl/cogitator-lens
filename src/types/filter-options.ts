import type {
	CompilerOutputOptions,
	ParseFiltersAndOutputOptions,
} from '../parsers/filters.interfaces.js';

/**
 * Cogitator Lens separates options that affect compiler output from filters
 * that can be reapplied to cached assembly.
 */
export type DisplayAssemblyFilters = Omit<
	ParseFiltersAndOutputOptions,
	keyof CompilerOutputOptions
>;

const compileOptionNames = new Set<keyof CompilerOutputOptions>([
	'binary',
	'binaryObject',
	'execute',
	'demangle',
	'intel',
	'verboseDemangling',
]);

export function partitionFilters(options: ParseFiltersAndOutputOptions): {
	outputOptions: CompilerOutputOptions;
	displayFilters: DisplayAssemblyFilters;
} {
	const outputOptions: CompilerOutputOptions = {};
	const displayFilters: DisplayAssemblyFilters = {};
	for (const [name, value] of Object.entries(options)) {
		if (compileOptionNames.has(name as keyof CompilerOutputOptions)) {
			Object.assign(outputOptions, { [name]: value });
		} else {
			Object.assign(displayFilters, { [name]: value });
		}
	}
	return { outputOptions, displayFilters };
}
