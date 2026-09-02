import type { CompileDiagnostic } from '../../types/index.js';
import { diagnosticUri, type DiagnosticParser, zeroBased } from '../../diagnostics.js';

/** Parses Go compiler records, whose messages do not include an explicit severity. */
export const parseGoDiagnostics: DiagnosticParser = (output, fallbackSource, workingDirectory) => {
	const diagnostics: CompileDiagnostic[] = [];
	for (const line of output.split(/\r?\n/u)) {
		const match = /^(.*\.go):(\d+)(?::(\d+))?:\s*(.+)$/iu.exec(line);
		if (!match) {
			continue;
		}
		diagnostics.push({
			uri: diagnosticUri(match[1], fallbackSource, workingDirectory),
			line: zeroBased(match[2]),
			column: zeroBased(match[3] ?? '1'),
			severity: 'error',
			message: match[4],
		});
	}
	return diagnostics;
};
