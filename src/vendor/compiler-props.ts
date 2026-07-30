import type { PropertyGetter, PropertyValue, Widen } from './lib/properties.interfaces.js';

/**
 * This extension has no compiler-properties system of its own; the vendored parsers'
 * optional `compilerProps` constructor parameter only ever needs to hand back each
 * caller's own default (`maxLinesOfAsm`, `binaryHideFuncRe`). The overloads mirror
 * `PropertyGetter`'s so a default of any `PropertyValue` type round-trips untouched.
 */
function noopGetter(property: string, defaultValue?: undefined): PropertyValue;
function noopGetter<T extends PropertyValue>(property: string, defaultValue: Widen<T>): typeof defaultValue;
function noopGetter<T extends PropertyValue>(property: string, defaultValue?: unknown): T;
function noopGetter(_property: string, defaultValue?: unknown): unknown {
	return defaultValue;
}

export const noopPropertyGetter: PropertyGetter = noopGetter;
