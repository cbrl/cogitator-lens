import {
	Diagnostic,
	DiagnosticSeverity,
	languages,
	Position,
	Range,
	type DiagnosticCollection,
	type Disposable,
	type Uri,
} from 'vscode';
import { uniqueDiagnostics } from '../diagnostics.js';
import { localFileUriComparisonKey } from '../file-identity.js';
import type { CompileDiagnostic } from '../types/index.js';
import type { ArtifactStatus } from './artifact-generator.js';

/** The name that the Problems view shows as the origin of each diagnostic. */
export const diagnosticSource = 'Cogitator Lens';

/**
 * Reports the compiler diagnostics of open artifacts in the Problems view. The open artifacts of one
 * source report the same compiler diagnostics, so each diagnostic shows once.
 */
export class ArtifactProblems implements Disposable {
	private readonly collection: DiagnosticCollection = languages.createDiagnosticCollection('coglens');
	private readonly reported = new Map<string, readonly CompileDiagnostic[]>();

	/** Records the diagnostics of a status. A status without a compile result keeps the earlier ones. */
	accept(documentKey: string, status: ArtifactStatus): void {
		const diagnostics = statusDiagnostics(status);
		if (diagnostics) {
			this.set(documentKey, diagnostics);
		}
	}

	set(documentKey: string, diagnostics: readonly CompileDiagnostic[]): void {
		const previous = this.reported.get(documentKey);
		if (diagnostics.length === 0 && !previous?.length) {
			return;
		}
		this.reported.set(documentKey, diagnostics);
		this.rebuild();
	}

	delete(documentKey: string): void {
		const previous = this.reported.get(documentKey);
		if (this.reported.delete(documentKey) && previous?.length) {
			this.rebuild();
		}
	}

	dispose(): void {
		this.reported.clear();
		this.collection.dispose();
	}

	private rebuild(): void {
		this.collection.clear();
		const grouped = new Map<string, { uri: Uri; diagnostics: Diagnostic[] }>();
		for (const item of uniqueDiagnostics([...this.reported.values()].flat())) {
			const key = localFileUriComparisonKey(item.uri);
			const group = grouped.get(key) ?? { uri: item.uri, diagnostics: [] };
			group.diagnostics.push(toDiagnostic(item));
			grouped.set(key, group);
		}
		for (const group of grouped.values()) {
			this.collection.set(group.uri, group.diagnostics);
		}
	}
}

/** The compiler diagnostics of a finished compile, or nothing while no compile has finished. */
function statusDiagnostics(status: ArtifactStatus): readonly CompileDiagnostic[] | undefined {
	switch (status.state) {
		case 'successful':
			return status.artifact.diagnostics;
		case 'failed':
			return status.diagnostics;
		default:
			return undefined;
	}
}

function toDiagnostic(item: CompileDiagnostic): Diagnostic {
	// With an empty range, the editor underlines the word at the position. This also works for a closed source.
	const position = new Position(item.line, item.column);
	const diagnostic = new Diagnostic(new Range(position, position), item.message, toDiagnosticSeverity(item.severity));
	diagnostic.source = diagnosticSource;
	return diagnostic;
}

function toDiagnosticSeverity(severity: CompileDiagnostic['severity']): DiagnosticSeverity {
	switch (severity) {
		case 'warning':
			return DiagnosticSeverity.Warning;
		case 'information':
			return DiagnosticSeverity.Information;
		default:
			return DiagnosticSeverity.Error;
	}
}
