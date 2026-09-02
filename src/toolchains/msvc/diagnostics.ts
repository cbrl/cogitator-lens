import type { CompileDiagnostic } from '../../types/index.js';
import { diagnosticSeverity, diagnosticUri, type DiagnosticParser, zeroBased } from '../../diagnostics.js';

/** Parses MSVC, Roslyn, and CUDA parenthesized source locations. */
export const parseParenthesizedDiagnostics: DiagnosticParser = (output, fallbackSource, workingDirectory) => {
	const diagnostics: CompileDiagnostic[] = [];
	for (const line of output.split(/\r?\n/u)) {
		const match =
			/^(.*?)\((\d+)(?:,(\d+))?(?:,(\d+),(\d+)|-(\d+)(?:,(\d+))?)?\)\s*:\s*(fatal\s+error|error|warning|note|information|info)\s*:?\s*(?:([A-Z]+\d+)\s*:\s*)?(.*)$/iu.exec(
				line,
			);
		if (!match) {
			continue;
		}
		const code = match[9];
		diagnostics.push({
			uri: diagnosticUri(match[1], fallbackSource, workingDirectory),
			line: zeroBased(match[2]),
			column: zeroBased(match[3] ?? '1'),
			severity: diagnosticSeverity(match[8]),
			message: code ? `${code}: ${match[10]}` : match[10],
		});
	}
	return diagnostics;
};
