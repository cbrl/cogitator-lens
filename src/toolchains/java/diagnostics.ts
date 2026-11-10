import type { CompileDiagnostic } from '../../types/index.js';
import { diagnosticSeverity, diagnosticUri, type DiagnosticParser } from '../../diagnostics.js';

/** The first line of a javac diagnostic, such as `src\p\Bad.java:9: error: incompatible types`. */
const location = /^(.+\.java):(\d+): (error|warning): (.*)$/u;
const caret = /^([^^]*)\^\s*$/u;

/**
 * Parses the diagnostics of javac. After the first line of a diagnostic, javac prints the source
 * line and a line with a caret under the column. The caret line copies the tabs of the source line,
 * so the caret position is the column. Indented lines after it, such as `  symbol:   variable x`,
 * complete the message. A note without a location, such as `Note: Recompile with -Xlint`, is not a
 * diagnostic.
 */
export const parseJavacDiagnostics: DiagnosticParser = (output, fallbackSource, workingDirectory) => {
	const diagnostics: CompileDiagnostic[] = [];
	let pending: (CompileDiagnostic & { phase: 'source' | 'caret' | 'details' }) | undefined;
	const finish = (): void => {
		if (pending) {
			const { phase: _phase, ...diagnostic } = pending;
			diagnostics.push(diagnostic);
		}
		pending = undefined;
	};
	for (const line of output.split(/\r?\n/u)) {
		const start = location.exec(line);
		if (start) {
			finish();
			pending = {
				uri: diagnosticUri(start[1], fallbackSource, workingDirectory),
				line: Math.max(0, Number(start[2]) - 1),
				column: 0,
				severity: diagnosticSeverity(start[3]),
				message: start[4].trim(),
				phase: 'source',
			};
			continue;
		}
		if (!pending) {
			continue;
		}
		if (pending.phase === 'source') {
			pending.phase = 'caret';
			continue;
		}
		const pointer = pending.phase === 'caret' ? caret.exec(line) : null;
		pending.phase = 'details';
		if (pointer) {
			pending.column = pointer[1].length;
		} else if (/^\s+\S/u.test(line)) {
			pending.message = `${pending.message}\n${line.trim()}`;
		} else {
			finish();
		}
	}
	finish();
	return diagnostics;
};
