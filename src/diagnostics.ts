import path from 'node:path';
import type { Uri } from 'vscode';
import type { CompileDiagnostic } from './types/index.js';
import { localFileUriComparisonKey, sameLocalFile } from './local-file-identity.js';

/** Converts one toolchain's textual output into source-positioned diagnostics. */
export type DiagnosticParser = (
	output: string,
	fallbackSource: Uri,
	workingDirectory: string,
) => readonly CompileDiagnostic[];

export type DiagnosticSeverity = CompileDiagnostic['severity'];

/** Resolves a diagnostic filename consistently across every parser family. */
export function diagnosticUri(filename: string, fallbackSource: Uri, workingDirectory: string): Uri {
	const trimmed = filename.trim();
	if (!trimmed) {
		return fallbackSource;
	}
	const resolved = path.isAbsolute(trimmed) ? trimmed : path.resolve(workingDirectory, trimmed);
	if (fallbackSource.scheme === 'file' && sameLocalFile(resolved, fallbackSource.fsPath)) {
		return fallbackSource;
	}
	const uriPath = resolved.replaceAll(path.sep, '/');
	return fallbackSource.with({
		scheme: 'file',
		authority: '',
		path: /^[A-Z]:\//iu.test(uriPath) ? `/${uriPath}` : uriPath,
		query: '',
		fragment: '',
	});
}

/** Composes parser families while suppressing identical host/device duplicates. */
export function composeDiagnosticParsers(...parsers: readonly DiagnosticParser[]): DiagnosticParser {
	return (output, fallbackSource, workingDirectory) => {
		const diagnostics = parsers.flatMap((parser) => [...parser(output, fallbackSource, workingDirectory)]);
		const seen = new Set<string>();
		return diagnostics.filter((diagnostic) => {
			const key = [
				localFileUriComparisonKey(diagnostic.uri),
				diagnostic.line,
				diagnostic.column,
				diagnostic.severity,
				diagnostic.message,
			].join('\0');
			if (seen.has(key)) {
				return false;
			}
			seen.add(key);
			return true;
		});
	};
}

/** Converts a one-based compiler source position to the zero-based editor representation. */
export function zeroBased(value: string): number {
	return Math.max(0, Number(value) - 1);
}

/** Normalizes tool-specific severity labels to the extension's diagnostic severity values. */
export function diagnosticSeverity(value: string): DiagnosticSeverity {
	const normalized = value.toLowerCase();
	if (normalized === 'warning') {
		return 'warning';
	}
	if (normalized === 'note' || normalized === 'information' || normalized === 'info') {
		return 'information';
	}
	return 'error';
}
