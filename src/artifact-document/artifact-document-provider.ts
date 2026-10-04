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
	ArtifactDocumentRegistry,
	type ArtifactRegistryDocument,
	type ArtifactView,
} from './artifact-document-registry.js';
import { localFileUriComparisonKey } from '../file-identity.js';
import type { ArtifactDocumentSnapshot } from './artifact-identity.js';

/** The state of one open text artifact document. */
class TextArtifactView implements ArtifactView {
	/** The text that the editor shows now. A cancelled refresh keeps it. */
	text?: string;
	diagnostics: readonly CompileDiagnostic[] = [];

	constructor(
		readonly document: ArtifactRegistryDocument,
		private readonly decorator: ArtifactDecorator,
		readonly refresh: () => void,
		readonly onStatus: () => void,
	) {}

	dispose(): void {
		this.decorator.dispose();
	}
}

export class ArtifactDocumentProvider implements TextDocumentContentProvider, Disposable {
	static readonly scheme = artifactScheme;

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
		const view = this.registry.view(uri, TextArtifactView) ?? this.openView(uri);
		return view.document.handler
			.update(token)
			.then((artifact) => {
				if (artifact.presentation !== 'text') {
					throw new CompilationError('Graph artifacts must be opened in the control-flow graph view.');
				}
				this.setDiagnostics(view, artifact.diagnostics);
				return artifact.lines.map((line) => line.text).join('\n');
			})
			.catch((error: unknown) => {
				if (error instanceof CancellationError || token.isCancellationRequested) {
					return view.text ?? '';
				}

				const diagnostics = error instanceof CompilationError ? error.diagnostics : [];
				this.setDiagnostics(view, diagnostics);

				const message = error instanceof Error ? error.message : String(error);
				return error instanceof CompilationError && error.truncated
					? `[truncated; process output limit exceeded]\n\n${message}`
					: message;
			})
			.then((text) => {
				view.text = text;
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
		const artifact = this.registry.view(uri, TextArtifactView)?.document.handler.status.artifact;
		return artifact?.presentation === 'text' ? artifact : undefined;
	}

	/** Returns already-known state only; activating a details view never compiles. */
	getArtifactDocumentState(uri: Uri): ArtifactDocumentSnapshot | undefined {
		return this.registry.view(uri, TextArtifactView)?.document.snapshot;
	}

	getActiveArtifactDocumentState(): ArtifactDocumentSnapshot | undefined {
		return this.activeView()?.document.snapshot;
	}

	refreshActiveArtifact(): boolean {
		const view = this.activeView();
		if (!view) {
			return false;
		}
		this.registry.requestRefresh(view.document.uri);
		return true;
	}

	cancelActiveArtifact(): boolean {
		return this.activeView()?.document.handler.cancel() ?? false;
	}

	requestRefresh(artifactUri: Uri): void {
		this.registry.requestRefresh(artifactUri);
	}

	dispose(): void {
		this.subscriptions.forEach((subscription) => subscription.dispose());
		for (const view of this.registry.views(TextArtifactView)) {
			this.registry.unregister(view.document.uri);
		}
	}

	private openView(uri: Uri): TextArtifactView {
		const view = this.registry.open(
			uri,
			(document) =>
				new TextArtifactView(
					document,
					new ArtifactDecorator(
						document.handler.sourceUri,
						document.handler.artifactUri,
						document.handler.onDidChange,
						this.configuration,
						(kind) => this.compilationService.getArtifactOptions(kind),
					),
					() => this.changeEmitter.fire(document.uri),
					() => this.refreshStatusBar(),
				),
		);
		this.refreshStatusBar();
		return view;
	}

	private setDiagnostics(view: TextArtifactView, items: readonly CompileDiagnostic[]): void {
		view.diagnostics = items;
		this.rebuildDiagnostics();
	}

	private onCloseTextDocument(document: TextDocument): void {
		if (!this.registry.view(document.uri, TextArtifactView)) {
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
		this.registry.unregister(uri);
		this.rebuildDiagnostics();
		this.refreshStatusBar();
	}

	private activeView(): TextArtifactView | undefined {
		const uri = window.activeTextEditor?.document.uri;
		return uri ? this.registry.view(uri, TextArtifactView) : undefined;
	}

	private refreshStatusBar(): void {
		const view = this.activeView();
		if (!view) {
			this.statusBar.hide();
			return;
		}
		const { identity, handler } = view.document;
		const { status } = handler;
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
			`${identity.artifactLabel} · ${path.basename(identity.sourceLabel)}`,
			`${identity.variantLabel} · ${identity.toolchainLabel}`,
			status.state === 'failed' ? status.error.message : `State: ${status.state}`,
			'Click for artifact actions',
		].join('\n');
		this.statusBar.show();
	}

	private rebuildDiagnostics(): void {
		this.diagnostics.clear();
		const grouped = new Map<string, { uri: Uri; diagnostics: Diagnostic[] }>();
		for (const view of this.registry.views(TextArtifactView)) {
			for (const item of view.diagnostics) {
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
