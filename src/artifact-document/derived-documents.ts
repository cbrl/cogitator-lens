import { Disposable, EventEmitter, Uri, type Event, type TextDocumentContentProvider } from 'vscode';
import type { ArtifactDocumentIdentity } from './artifact-identity.js';

/** The scheme of read-only documents with fixed text, such as an earlier result of an artifact. */
export const derivedScheme = 'coglens-derived';

/** The number of derived documents that keep their text. The oldest goes first. */
const maximumDocuments = 64;
/** The number of snapshots that are kept. The oldest goes first. */
const maximumSnapshots = 20;

/**
 * Serves fixed text for one side of a comparison. A `coglens-artifact:` document has its own
 * generator and compile, so an earlier result cannot use that scheme.
 */
export class DerivedDocumentProvider implements TextDocumentContentProvider, Disposable {
	private readonly documents = new Map<string, string>();
	private readonly changeEmitter = new EventEmitter<Uri>();
	private nextId = 1;

	readonly onDidChange: Event<Uri> = this.changeEmitter.event;

	/** Makes a document with the text. The file name sets the tab title and the language. */
	create(text: string, filename: string): Uri {
		const uri = Uri.from({ scheme: derivedScheme, path: `/${this.nextId++}/${filename}` });
		this.documents.set(uri.toString(), text);
		while (this.documents.size > maximumDocuments) {
			this.documents.delete(this.documents.keys().next().value!);
		}
		return uri;
	}

	provideTextDocumentContent(uri: Uri): string {
		return (
			this.documents.get(uri.toString()) ??
			'This earlier result is no longer available. Run the comparison again.'
		);
	}

	dispose(): void {
		this.documents.clear();
		this.changeEmitter.dispose();
	}
}

/** The text of an artifact at one time, kept until VS Code closes. */
export interface ArtifactSnapshot {
	readonly id: number;
	readonly label: string;
	readonly createdAt: number;
	readonly identity: ArtifactDocumentIdentity;
	readonly text: string;
	/** The file name of the artifact document, which sets the language of a derived document. */
	readonly filename: string;
}

/** The snapshots of artifact text in memory. The list is small, and the oldest snapshot goes first. */
export class ArtifactSnapshots {
	private readonly items: ArtifactSnapshot[] = [];
	private nextId = 1;

	add(identity: ArtifactDocumentIdentity, text: string, filename: string, label?: string): ArtifactSnapshot {
		const createdAt = Date.now();
		const snapshot: ArtifactSnapshot = Object.freeze({
			id: this.nextId,
			label: label?.trim() || `Snapshot ${this.nextId}`,
			createdAt,
			identity,
			text,
			filename,
		});
		this.nextId++;
		this.items.push(snapshot);
		if (this.items.length > maximumSnapshots) {
			this.items.shift();
		}
		return snapshot;
	}

	/** The snapshots, newest first. */
	list(): readonly ArtifactSnapshot[] {
		return [...this.items].reverse();
	}
}
