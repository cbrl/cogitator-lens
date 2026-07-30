// Local shim for Compiler Explorer's lib/assert.js, providing only the `assert` signature
// the vendored parsers import. Upstream's version also captures a stack-trace diagnostic;
// that is CE-server diagnostics infrastructure this extension has no use for.

export function assert(condition: unknown, message?: string, ...extra: unknown[]): asserts condition {
	if (!condition) {
		let text = 'Assertion failed';
		if (message) {
			text += `: ${message}`;
		}
		if (extra.length > 0) {
			try {
				text += `, ${JSON.stringify(extra)}`;
			} catch {
				// ignore values that cannot be serialized
			}
		}
		throw new Error(text);
	}
}
