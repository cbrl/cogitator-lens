// Local shim for Compiler Explorer's shared/common-utils.js, providing only what the
// vendored parsers in ../lib/parsers import.

export function isString(x: unknown): x is string {
	return typeof x === 'string' || x instanceof String;
}
