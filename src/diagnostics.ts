import { Uri } from 'vscode';
import type { CompileDiagnostic } from './types/index.js';

export function parseCompilerDiagnostics(output: string, fallbackSource: Uri): CompileDiagnostic[] {
	const diagnostics: CompileDiagnostic[] = [];
	for (const line of output.split(/\r?\n/)) {
		const gcc = /^(.*?):(\d+):(\d+):\s*(?:fatal\s+)?(error|warning|note):\s*(.*)$/.exec(line);
		if (gcc) {
			diagnostics.push({
				uri: Uri.file(gcc[1]),
				line: Math.max(0, Number(gcc[2]) - 1),
				column: Math.max(0, Number(gcc[3]) - 1),
				severity: gcc[4] === 'note' ? 'information' : gcc[4] as 'error' | 'warning',
				message: gcc[5],
			});
			continue;
		}

		const msvc = /^(.*?)\((\d+)(?:,(\d+))?\):\s*(?:(?:fatal\s+)?(error|warning)\s+[A-Z]+\d+:\s*)?(.*)$/i.exec(line);
		if (msvc && (msvc[4] || /(?:error|warning)/i.test(msvc[5]))) {
			diagnostics.push({
				uri: msvc[1] ? Uri.file(msvc[1]) : fallbackSource,
				line: Math.max(0, Number(msvc[2]) - 1),
				column: Math.max(0, Number(msvc[3] ?? 1) - 1),
				severity: msvc[4]?.toLowerCase() === 'warning' ? 'warning' : 'error',
				message: msvc[5],
			});
		}
	}
	return diagnostics;
}
