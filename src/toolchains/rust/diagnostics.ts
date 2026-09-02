import type { CompileDiagnostic } from '../../types/index.js';
import {
	diagnosticSeverity,
	diagnosticUri,
	type DiagnosticParser,
	type DiagnosticSeverity,
	zeroBased,
} from '../../diagnostics.js';

/** Parses Rust's stateful severity-header followed by source-location form. */
export const parseRustDiagnostics: DiagnosticParser = (output, fallbackSource, workingDirectory) => {
	const diagnostics: CompileDiagnostic[] = [];
	let pending: { severity: DiagnosticSeverity; message: string } | undefined;
	for (const line of output.split(/\r?\n/u)) {
		const location = /^\s*-->\s+(.*):(\d+):(\d+)\s*$/u.exec(line);
		if (location && pending) {
			diagnostics.push({
				uri: diagnosticUri(location[1], fallbackSource, workingDirectory),
				line: zeroBased(location[2]),
				column: zeroBased(location[3]),
				severity: pending.severity,
				message: pending.message,
			});
			pending = undefined;
			continue;
		}
		const header = /^(error|warning|note)(\[[^\]]+\])?:\s*(.*)$/u.exec(line);
		if (header) {
			pending = {
				severity: diagnosticSeverity(header[1]),
				message: `${header[2] ? `${header[2]} ` : ''}${header[3]}`,
			};
		}
	}
	return diagnostics;
};
