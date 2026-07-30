// Local shim for Compiler Explorer's lib/logger.js, providing only the error and warning
// methods the vendored parsers call on malformed input. Upstream's version is a
// winston logger with file transports and log levels this extension has no use for.
//
// This writes to stderr rather than the extension's own `logChannel` (src/logger.ts) so
// that vendored parser code stays importable from plain Node (unit tests, `vendor:check`)
// without pulling in the `vscode` module. The branch that calls this is a defensive
// "somehow malformed input" log, not user-facing diagnostics.

import util from 'node:util';

export const logger = {
	error(message: string, ...args: unknown[]): void {
		console.error(util.format(message, ...args));
	},
	warn(message: string, ...args: unknown[]): void {
		console.warn(util.format(message, ...args));
	},
};
