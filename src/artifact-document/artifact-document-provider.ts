import {
	CancellationError,
	CancellationToken,
	Diagnostic,
	DiagnosticCollection,
	DiagnosticSeverity,
	Disposable,
	Event,
	EventEmitter,
	languages,
	Position,
	ProviderResult,
	Range,
	StatusBarAlignment,
	StatusBarItem,
	TabInputText,
	TextDocument,
	TextDocumentContentProvider,
	Uri,
	window,
	workspace,
} from 'vscode';
import path from 'path';
import { CompilationService } from '../compilation/index.js';
import type { ConfigurationService } from '../services/configuration-service.js';
import { CompilationError, type CompileDiagnostic, type RenderedTextArtifact } from '../types/index.js';
import { artifactScheme } from './artifact-uri.js';
import { ArtifactDecorator } from './artifact-decorator.js';
import {
	artifactDocumentKey,
	ArtifactDocumentRegistry,
	type ArtifactRegistryDocument,
} from './artifact-document-registry.js';
import { localFileUriComparisonKey } from '../local-file-identity.js';
import type { ArtifactDocumentSnapshot } from './artifact-identity.js';

interface ArtifactDocument {
	readonly registered: ArtifactRegistryDocument;
	decorator?: ArtifactDecorator;
	/** The text that the editor shows now. A cancelled refresh keeps it. */
	text?: string;
	diagnostics: readonly CompileDiagnostic[];
}

export class ArtifactDocumentProvider implements TextDocumentContentProvider, Disposable {
	static readonly scheme = artifactScheme;

	private readonly documents = new Map<string, ArtifactDocument>();
	private readonly changeEmitter = new EventEmitter<Uri>();
	private readonly diagnostics: DiagnosticCollection = languages.createDiagnosticCollection('coglens');
	private readonly statusBar: StatusBarItem = window.createStatusBarItem(StatusBarAlignment.Right, 1000);
	private readonly subscriptions: Disposable[];

	constructor(
		private readonly compilationService: CompilationService,
		private readonly configuration: ConfigurationService,
		private readonly registry: ArtifactDocumentRegistry,
	) {
		this.subscriptions = [
			workspace.onDidCloseTextDocument((document) => this.onCloseTextDocument(document)),
			window.onDidChangeActiveTextEditor(() => this.refreshStatusBar()),
			this.changeEmitter,
			this.diagnostics,
			this.statusBar,
		];
		this.statusBar.name = 'Cogitator Lens Artifact Status';
		this.statusBar.command = 'coglens.ShowArtifactStatus';
	}

	// Implements TextDocumentContentProvider.provideTextDocumentContent. This function will be called for the given
	// Uri when onDidChange(Uri) is fired. onDidChange will be fired when a source document changes and is recompiled
	// (or fails to recompile).
	provideTextDocumentContent(uri: Uri, token: CancellationToken): ProviderResult<string> {
		const document = this.getOrCreateDocument(uri);
		const handler = document.registered.handler;

		if (!document.decorator) {
			document.decorator = new ArtifactDecorator(
				handler.sourceUri,
				handler.artifactUri,
				handler.onDidChange,
				this.configuration,
				(kind) => this.compilationService.getArtifactOptions(kind),
			);
		}

		const compilation = handler.update(token);

		return compilation
			.then((artifact) => {
				if (artifact.presentation !== 'text') {
					throw new CompilationError('Graph artifacts must be opened in the control-flow graph view.');
				}
				this.setDiagnostics(document, artifact.diagnostics);
				return artifact.lines.map((line) => line.text).join('\n');
			})
			.catch((error: unknown) => {
				if (error instanceof CancellationError || token.isCancellationRequested) {
					return document.text ?? '';
				}

				const diagnostics = error instanceof CompilationError ? error.diagnostics : [];
				this.setDiagnostics(document, diagnostics);

				const message = error instanceof Error ? error.message : String(error);
				return error instanceof CompilationError && error.truncated
					? `[truncated; process output limit exceeded]\n\n${message}`
					: message;
			})
			.then((text) => {
				document.text = text;
				return text;
			});
	}

	get onDidChange(): Event<Uri> {
		return this.changeEmitter.event;
	}

	get onDidChangeArtifactState(): Event<ArtifactDocumentSnapshot> {
		return this.registry.onDidChangeArtifactState;
	}

	getRenderedArtifact(uri: Uri): RenderedTextArtifact | undefined {
		const artifact = this.documents.get(artifactDocumentKey(uri))?.registered.handler.status.artifact;
		return artifact?.presentation === 'text' ? artifact : undefined;
	}

	/** Returns already-known state only; activating a details view never compiles. */
	getArtifactDocumentState(uri: Uri): ArtifactDocumentSnapshot | undefined {
		const document = this.documents.get(artifactDocumentKey(uri));
		return document
			? { identity: document.registered.identity, status: document.registered.handler.status }
			: undefined;
	}

	getActiveArtifactDocumentState(): ArtifactDocumentSnapshot | undefined {
		const document = this.activeArtifactDocument();
		return document
			? { identity: document.registered.identity, status: document.registered.handler.status }
			: undefined;
	}

	refreshActiveArtifact(): boolean {
		const document = this.activeArtifactDocument();
		if (!document) {
			return false;
		}
		this.requestRefresh(document.registered.uri);
		return true;
	}

	cancelActiveArtifact(): boolean {
		return this.activeArtifactDocument()?.registered.handler.cancel() ?? false;
	}

	requestRefresh(assemblyUri: Uri): void {
		this.registry.requestRefresh(assemblyUri);
	}

	dispose(): void {
		this.subscriptions.forEach((subscription) => subscription.dispose());
		for (const document of this.documents.values()) {
			document.decorator?.dispose();
			this.registry.unregister(document.registered.uri);
		}
		this.documents.clear();
	}

	private getOrCreateDocument(assemblyUri: Uri): ArtifactDocument {
		const key = artifactDocumentKey(assemblyUri);
		const existing = this.documents.get(key);
		if (existing) {
			return existing;
		}

		const registered = this.registry.open(assemblyUri, {
			refresh: (document) => this.changeEmitter.fire(document.uri),
			onStatus: () => this.refreshStatusBar(),
		});
		const document: ArtifactDocument = {
			registered,
			diagnostics: [],
		};
		this.documents.set(key, document);
		this.refreshStatusBar();

		return document;
	}

	private setDiagnostics(document: ArtifactDocument, items: readonly CompileDiagnostic[]): void {
		document.diagnostics = items;
		this.rebuildDiagnostics();
	}

	private onCloseTextDocument(document: TextDocument): void {
		if (!this.documents.has(artifactDocumentKey(document.uri))) {
			return;
		}

		// Guard against race condition: if the user reopens the same assembly document quickly,
		// the delayed close event from the old document would destroy the new handler/decorator.
		// Only clean up if no tab still shows this document.
		const remainsOpen = window.tabGroups.all.some((group) =>
			group.tabs.some(
				(tab) => tab.input instanceof TabInputText && tab.input.uri.toString() === document.uri.toString(),
			),
		);

		if (!remainsOpen) {
			this.unregisterDocument(document.uri);
		}
	}

	private unregisterDocument(uri: Uri): void {
		const key = artifactDocumentKey(uri);
		const document = this.documents.get(key);
		if (!document) {
			return;
		}

		document.decorator?.dispose();
		this.registry.unregister(uri);
		this.documents.delete(key);
		this.rebuildDiagnostics();
		this.refreshStatusBar();
	}

	private activeArtifactDocument(): ArtifactDocument | undefined {
		const uri = window.activeTextEditor?.document.uri;
		return uri ? this.documents.get(artifactDocumentKey(uri)) : undefined;
	}

	private refreshStatusBar(): void {
		const document = this.activeArtifactDocument();
		if (!document) {
			this.statusBar.hide();
			return;
		}
		this.updateStatusBar(document);
	}

	private updateStatusBar(document: ArtifactDocument): void {
		const { status } = document.registered.handler;
		switch (status.state) {
			case 'compiling':
				this.statusBar.text = '$(sync~spin) Compiling';
				break;
			case 'stale':
				this.statusBar.text = '$(history) Stale';
				break;
			case 'cancelled':
				this.statusBar.text = '$(circle-slash) Cancelled';
				break;
			case 'failed':
				this.statusBar.text = status.truncated ? '$(warning) Truncated' : '$(error) Failed';
				break;
			case 'successful':
				this.statusBar.text = status.truncated ? '$(warning) Truncated' : '$(check) Ready';
				break;
		}
		this.statusBar.tooltip = [
			`${document.registered.identity.artifactLabel} · ${path.basename(document.registered.identity.sourceLabel)}`,
			`${document.registered.identity.variantLabel} · ${document.registered.identity.toolchainLabel}`,
			status.state === 'failed' ? status.error.message : `State: ${status.state}`,
			'Click for artifact actions',
		].join('\n');
		this.statusBar.show();
	}

	private rebuildDiagnostics(): void {
		this.diagnostics.clear();
		const grouped = new Map<string, { uri: Uri; diagnostics: Diagnostic[] }>();
		for (const document of this.documents.values()) {
			for (const item of document.diagnostics) {
				const key = localFileUriComparisonKey(item.uri);
				const group = grouped.get(key) ?? { uri: item.uri, diagnostics: [] };
				group.diagnostics.push(
					new Diagnostic(
						new Range(new Position(item.line, item.column), new Position(item.line, item.column + 1)),
						item.message,
						toDiagnosticSeverity(item.severity),
					),
				);
				grouped.set(key, group);
			}
		}
		for (const group of grouped.values()) {
			this.diagnostics.set(group.uri, group.diagnostics);
		}
	}
}

export { getArtifactUri, parseArtifactUri } from './artifact-uri.js';

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
