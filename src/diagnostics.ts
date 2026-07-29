import { Uri } from 'vscode';
import path from 'path';
import type { CompileDiagnostic } from './types/index.js';

export function parseToolDiagnostics(
	output: string,
	fallbackSource: Uri,
	workingDirectory = path.dirname(fallbackSource.fsPath),
): CompileDiagnostic[] {
	const diagnostics: CompileDiagnostic[] = [];
	for (const line of output.split(/\r?\n/)) {
		const gcc = /^(.*?):(\d+):(\d+):\s*(?:fatal\s+)?(error|warning|note):\s*(.*)$/.exec(line);
		if (gcc) {
			diagnostics.push({
				uri: diagnosticUri(gcc[1], fallbackSource, workingDirectory),
				line: Math.max(0, Number(gcc[2]) - 1),
				column: Math.max(0, Number(gcc[3]) - 1),
				severity: gcc[4] === 'note' ? 'information' : gcc[4] as 'error' | 'warning',
				message: gcc[5],
			});
			continue;
		}

		const msvc = /^(.*?)\((\d+)(?:,(\d+))?\):\s*(?:fatal\s+)?(error|warning)\s+([A-Z]+\d+):\s*(.*)$/i.exec(line);
		if (msvc) {
			diagnostics.push({
				uri: diagnosticUri(msvc[1], fallbackSource, workingDirectory),
				line: Math.max(0, Number(msvc[2]) - 1),
				column: Math.max(0, Number(msvc[3] ?? 1) - 1),
				severity: msvc[4].toLowerCase() === 'warning' ? 'warning' : 'error',
				message: msvc[6],
			});
		}
	}
	return diagnostics;
}

function diagnosticUri(filename: string, fallbackSource: Uri, workingDirectory: string): Uri {
	const trimmed = filename.trim();
	if (!trimmed) {
		return fallbackSource;
	}
	return Uri.file(path.isAbsolute(trimmed) ? trimmed : path.resolve(workingDirectory, trimmed));
}
