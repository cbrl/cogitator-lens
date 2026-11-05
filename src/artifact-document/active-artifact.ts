import { Disposable, EventEmitter, window, type Event } from 'vscode';
import { sourceUriComparisonKey } from '../file-identity.js';
import type { ArtifactDocumentRegistry, ArtifactRegistryDocument } from './artifact-document-registry.js';

/** What the active artifact needs to know about the graph panels. */
export interface GraphPanelFocus {
	/** The document of the focused graph panel. */
	readonly activeDocument: ArtifactRegistryDocument | undefined;
	/** The documents of the visible graph panels. */
	visibleDocuments(): readonly ArtifactRegistryDocument[];
	/** Fires when a graph panel opens, closes, or changes its focus or visibility. */
	readonly onDidChangePanels: Event<void>;
}

/**
 * Finds the artifact that the status bar and the artifact commands act on. This is the focused
 * artifact, or else a visible artifact of the focused source. An artifact opens beside its source
 * and keeps the focus in the source, so the source is often the focused editor.
 */
export class ActiveArtifact implements Disposable {
	private readonly changeEmitter = new EventEmitter<void>();
	private readonly subscriptions: Disposable;

	/** Fires when the active artifact or its state can be different. */
	readonly onDidChange: Event<void> = this.changeEmitter.event;

	constructor(
		private readonly registry: ArtifactDocumentRegistry,
		private readonly graphs: GraphPanelFocus,
	) {
		const changed = (): void => this.changeEmitter.fire();
		this.subscriptions = Disposable.from(
			window.onDidChangeActiveTextEditor(changed),
			window.onDidChangeVisibleTextEditors(changed),
			graphs.onDidChangePanels(changed),
			registry.onDidChangeDocuments(changed),
			registry.onDidChangeArtifactState(changed),
			this.changeEmitter,
		);
	}

	get document(): ArtifactRegistryDocument | undefined {
		const graph = this.graphs.activeDocument;
		if (graph) {
			return graph;
		}
		const editorUri = window.activeTextEditor?.document.uri;
		if (!editorUri) {
			return undefined;
		}
		const focused = this.registry.document(editorUri);
		if (focused || editorUri.scheme !== 'file') {
			return focused;
		}
		const sourceKey = sourceUriComparisonKey(editorUri);
		const visible = [
			...window.visibleTextEditors.flatMap((editor) => this.registry.document(editor.document.uri) ?? []),
			...this.graphs.visibleDocuments(),
		];
		return visible.find((document) => sourceUriComparisonKey(document.parsed.source) === sourceKey);
	}

	dispose(): void {
		this.subscriptions.dispose();
	}
}
