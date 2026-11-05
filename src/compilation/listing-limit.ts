import type { PropertyGetter, PropertyValue, Widen } from '../vendor/lib/properties.interfaces.js';

/** The number of lines that a binary disassembly or LLVM IR listing shows by default. */
export const defaultListingLineLimit = 5000;
export const minimumListingLineLimit = 100;
export const maximumListingLineLimit = 1_000_000;

let listingLineLimit = defaultListingLineLimit;

/** Sets the line limit of the listings that the parsers make from now on. */
export function setListingLineLimit(limit: number): void {
	listingLineLimit = parseListingLineLimit(limit) ?? defaultListingLineLimit;
}

export function getListingLineLimit(): number {
	return listingLineLimit;
}

/** A whole number of lines within the limits, from a setting or from text that the user typed. */
export function parseListingLineLimit(value: unknown): number | undefined {
	const limit = typeof value === 'string' && value.trim() ? Number(value.trim()) : value;
	return typeof limit === 'number' &&
		Number.isInteger(limit) &&
		limit >= minimumListingLineLimit &&
		limit <= maximumListingLineLimit
		? limit
		: undefined;
}

/**
 * Gives the vendored parsers the line limit as `maxLinesOfAsm`, and each other property its default.
 * A parser reads the limit when it is made, so a parser is made again when the limit changes.
 */
function listingGetter(property: string, defaultValue?: undefined): PropertyValue;
function listingGetter<T extends PropertyValue>(property: string, defaultValue: Widen<T>): typeof defaultValue;
function listingGetter<T extends PropertyValue>(property: string, defaultValue?: unknown): T;
function listingGetter(property: string, defaultValue?: unknown): unknown {
	return property === 'maxLinesOfAsm' ? listingLineLimit : defaultValue;
}

export const listingPropertyGetter: PropertyGetter = listingGetter;

/** Keeps one value per line limit, and makes the value again when the limit changes. */
export function perListingLineLimit<T>(create: () => T): () => T {
	let current: { readonly limit: number; readonly value: T } | undefined;
	return () => {
		if (current?.limit !== listingLineLimit) {
			current = { limit: listingLineLimit, value: create() };
		}
		return current.value;
	};
}
