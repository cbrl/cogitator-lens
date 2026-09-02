import type { CompileDiagnostic } from '../../types/index.js';
import { diagnosticUri, type DiagnosticParser } from '../../diagnostics.js';

/** Parses Python traceback source/pointer gutters and syntax-error summaries. */
export const parsePythonDiagnostics: DiagnosticParser = (output, fallbackSource, workingDirectory) => {
	const diagnostics: CompileDiagnostic[] = [];
	let pending: { filename: string; line: number; sourceIndent?: number; column: number } | undefined;
	for (const line of output.split(/\r?\n/u)) {
		const location = /^\s*File "(.*)", line (\d+)(?:, in .*)?\s*$/u.exec(line);
		if (location) {
			pending = { filename: location[1], line: Number(location[2]), column: 0 };
			continue;
		}
		if (!pending) {
			continue;
		}
		const pointer = /^(\s*)\^/u.exec(line);
		if (pointer) {
			pending.column = Math.max(0, pointer[1].length - (pending.sourceIndent ?? 0));
			continue;
		}
		const error = /^(SyntaxError|IndentationError|TabError):\s*(.*)$/u.exec(line);
		if (error) {
			diagnostics.push({
				uri: diagnosticUri(pending.filename, fallbackSource, workingDirectory),
				line: Math.max(0, pending.line - 1),
				column: pending.column,
				severity: 'error',
				message: `${error[1]}: ${error[2]}`,
			});
			pending = undefined;
			continue;
		}
		if (line.trim()) {
			pending.sourceIndent = /^\s*/u.exec(line)?.[0].length ?? 0;
		}
	}
	return diagnostics;
};
