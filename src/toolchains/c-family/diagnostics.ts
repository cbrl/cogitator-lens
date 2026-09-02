import type { CompileDiagnostic } from '../../types/index.js';
import { diagnosticSeverity, diagnosticUri, type DiagnosticParser, zeroBased } from '../../diagnostics.js';

/** Parses GCC/Clang/Zig-style path, line, optional column, severity, and message records. */
export const parseGnuDiagnostics: DiagnosticParser = (output, fallbackSource, workingDirectory) => {
	const diagnostics: CompileDiagnostic[] = [];
	for (const line of output.split(/\r?\n/u)) {
		const match = /^(.*?):(\d+)(?::(\d+))?:\s*(?:fatal\s+)?(error|warning|note):\s*(.*)$/iu.exec(line);
		if (!match) {
			continue;
		}
		diagnostics.push({
			uri: diagnosticUri(match[1], fallbackSource, workingDirectory),
			line: zeroBased(match[2]),
			column: zeroBased(match[3] ?? '1'),
			severity: diagnosticSeverity(match[4]),
			message: match[5],
		});
	}
	return diagnostics;
};
