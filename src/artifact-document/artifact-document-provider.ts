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
	RelativePattern,
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
import { artifactDefinitions } from '../artifacts/core/artifact-definitions.js';
import { CompilationService } from '../compilation/index.js';
import type { ConfigurationService } from '../services/configuration-service.js';
import {
	CompilationError,
	type CompileDiagnostic,
	type RenderedTextArtifact,
} from '../types/index.js';
import { toComparisonKey } from '../utils.js';
import { sourceUriMap, sourceUriSet, UriSet } from '../uri-containers.js';
import {
	artifactScheme,
	getArtifactUri,
	parseArtifactUri,
} from './artifact-uri.js';
import { ArtifactDecorator } from './artifact-decorator.js';
import { getContent, type ArtifactDocumentContent } from './artifact-document-content.js';
import { ArtifactGenerator } from './artifact-generator.js';
import type { ArtifactStatus } from './artifact-generator.js';
import type {
	ArtifactDocumentIdentity,
	ArtifactDocumentSnapshot,
} from './artifact-identity.js';

interface ArtifactDocument {
	readonly identity: ArtifactDocumentIdentity;
	readonly handler: ArtifactGenerator;
	readonly watcher: Disposable;
	decorator?: ArtifactDecorator;
	assembly?: ArtifactDocumentContent;
	pendingRefresh?: ReturnType<typeof setTimeout>;
	diagnostics: readonly CompileDiagnostic[];
}

function documentKey(uri: Uri): string {
	return toComparisonKey(uri, true, process.platform === 'win32');
}

export class ArtifactDocumentProvider implements TextDocumentContentProvider, Disposable {
	static readonly scheme = artifactScheme;

	private readonly documents = new Map<string, ArtifactDocument>();
	private readonly sourceToArtifacts = sourceUriMap<UriSet>();
	private readonly changeEmitter = new EventEmitter<Uri>();
	private readonly artifactStateEmitter = new EventEmitter<ArtifactDocumentSnapshot>();
	private readonly diagnostics: DiagnosticCollection = languages.createDiagnosticCollection('coglens');
	private readonly statusBar: StatusBarItem = window.createStatusBarItem(StatusBarAlignment.Right, 1000);
	private readonly subscriptions: Disposable[];

	constructor(
		private readonly compilationService: CompilationService,
		private readonly configuration: ConfigurationService,
	) {
		this.subscriptions = [
			workspace.onDidCloseTextDocument(document => this.onCloseTextDocument(document)),
			window.onDidChangeActiveTextEditor(() => this.refreshStatusBar()),
			compilationService.onVariantsChanged(sources => {
				for (const source of sources) {
					for (const assembly of this.sourceToArtifacts.get(source)?.values() ?? []) {
						this.requestRefresh(assembly);
					}
				}
			}),
			compilationService.onArtifactOptionsChanged(() => {
				for (const document of this.documents.values()) {
					this.requestRefresh(document.handler.artifactUri);
				}
			}),
			configuration.onDidChange(() => {
				for (const document of this.documents.values()) {
					this.requestRefresh(document.handler.artifactUri);
				}
			}),
			this.changeEmitter,
			this.artifactStateEmitter,
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
		const handler = document.handler;

		if (!document.decorator) {
			document.decorator = new ArtifactDecorator(
				handler.sourceUri,
				handler.artifactUri,
				handler.onDidChange,
				this.configuration,
				kind => this.compilationService.getArtifactOptions(kind),
			);
		}

		const compilation = handler.update(token);

		return compilation.then(({ assembly, artifact }) => {
			if (artifact.presentation !== 'text' || !assembly) {
				throw new CompilationError('Graph artifacts must be opened in the control-flow graph view.');
			}
			document.assembly = assembly;
			this.setDiagnostics(document, artifact.diagnostics);

			return getContent(assembly);
		}).catch((error: unknown) => {
			if (error instanceof CancellationError || token.isCancellationRequested) {
				return document.assembly ? getContent(document.assembly) : '';
			}

			document.assembly = undefined;
			const diagnostics = error instanceof CompilationError ? error.diagnostics : [];
			this.setDiagnostics(document, diagnostics);

			const message = error instanceof Error ? error.message : String(error);
			return error instanceof CompilationError && error.truncated
				? `[truncated; process output limit exceeded]\n\n${message}`
				: message;
		});
	}

	get onDidChange(): Event<Uri> {
		return this.changeEmitter.event;
	}

	get onDidChangeArtifactState(): Event<ArtifactDocumentSnapshot> {
		return this.artifactStateEmitter.event;
	}

	getArtifactDocumentContent(uri: Uri): ArtifactDocumentContent | undefined {
		return this.documents.get(documentKey(uri))?.assembly;
	}

	getRenderedArtifact(uri: Uri): RenderedTextArtifact | undefined {
		const artifact = this.documents.get(documentKey(uri))?.handler.status.artifact;
		return artifact?.presentation === 'text' ? artifact : undefined;
	}

	/** Returns already-known state only; activating a details view never compiles. */
	getArtifactDocumentState(uri: Uri): ArtifactDocumentSnapshot | undefined {
		const document = this.documents.get(documentKey(uri));
		return document
			? { identity: document.identity, status: document.handler.status }
			: undefined;
	}

	getActiveArtifactDocumentState(): ArtifactDocumentSnapshot | undefined {
		const document = this.activeArtifactDocument();
		return document
			? { identity: document.identity, status: document.handler.status }
			: undefined;
	}

	refreshActiveArtifact(): boolean {
		const document = this.activeArtifactDocument();
		if (!document) {
			return false;
		}
		this.requestRefresh(document.handler.artifactUri);
		return true;
	}

	cancelActiveArtifact(): boolean {
		return this.activeArtifactDocument()?.handler.cancel() ?? false;
	}

	requestRefresh(assemblyUri: Uri): void {
		const document = this.documents.get(documentKey(assemblyUri));
		if (!document) {
			return;
		}
		document.handler.markStale();
		if (document.pendingRefresh) {
			clearTimeout(document.pendingRefresh);
		}
		document.pendingRefresh = setTimeout(() => {
			document.pendingRefresh = undefined;
			this.changeEmitter.fire(assemblyUri);
		}, 50);
	}

	dispose(): void {
		this.subscriptions.forEach(subscription => subscription.dispose());
		for (const document of this.documents.values()) {
			if (document.pendingRefresh) {
				clearTimeout(document.pendingRefresh);
			}
			document.watcher.dispose();
			document.decorator?.dispose();
			document.handler.dispose();
		}
		this.documents.clear();
	}

	private getOrCreateDocument(assemblyUri: Uri): ArtifactDocument {
		const key = documentKey(assemblyUri);
		const existing = this.documents.get(key);
		if (existing) {
			return existing;
		}

		const identity = parseArtifactUri(assemblyUri);
		if (!identity) {
			throw new CompilationError(`Invalid artifact document URI: ${assemblyUri.toString()}`);
		}
		const variant = this.compilationService.getVariants(identity.source)
			.find(candidate => candidate.id === identity.variantId);
		if (!variant) {
			throw new CompilationError(`Compilation variant is no longer available: ${identity.variantId}`);
		}
		const handler = new ArtifactGenerator(
			identity.source,
			assemblyUri,
			variant,
			identity.artifactKind,
			identity.presetId,
			this.compilationService,
			identity.artifactOutputId,
		);
		const profile = this.compilationService.toolchainRegistry
			.getToolchainById(variant.toolchainProfileId)?.profile;
		const documentIdentity: ArtifactDocumentIdentity = {
			documentUri: assemblyUri.toString(),
			sourceUri: identity.source.toString(),
			sourceLabel: identity.source.fsPath,
			artifactKind: identity.artifactKind,
			artifactLabel: artifactDefinitions[identity.artifactKind].label,
			...(identity.artifactOutputId
				? { artifactOutputId: identity.artifactOutputId }
				: {}),
			presetId: identity.presetId,
			variantId: variant.id,
			variantLabel: variant.displayLabel,
			toolchainId: profile?.id ?? variant.toolchainProfileId,
			toolchainLabel: profile?.displayName ?? variant.toolchainProfileId,
			toolchainKind: profile?.kind ?? 'unknown',
			renderedIdentity: assemblyUri.toString(),
		};

		let assemblyUris = this.sourceToArtifacts.get(identity.source);
		if (!assemblyUris) {
			assemblyUris = sourceUriSet();
			this.sourceToArtifacts.set(identity.source, assemblyUris);
		}
		assemblyUris.add(assemblyUri);

		const watcher = workspace.createFileSystemWatcher(new RelativePattern(
			Uri.file(path.dirname(identity.source.fsPath)),
			path.basename(identity.source.fsPath),
		));
		const document: ArtifactDocument = {
			identity: documentIdentity,
			handler,
			watcher: Disposable.from(
				watcher,
				watcher.onDidChange(() => this.requestRefresh(assemblyUri)),
				handler.onDidChange(status => this.onHandlerStatus(assemblyUri, status)),
			),
			diagnostics: [],
		};
		this.documents.set(key, document);
		this.artifactStateEmitter.fire({
			identity: documentIdentity,
			status: handler.status,
		});
		this.refreshStatusBar();

		return document;
	}

	private onHandlerStatus(assemblyUri: Uri, status: ArtifactStatus): void {
		const document = this.documents.get(documentKey(assemblyUri));
		if (!document) {
			return;
		}
		if (status.state === 'successful') {
			document.assembly = status.assembly;
		} else if (status.state === 'failed') {
			document.assembly = undefined;
		}
		this.refreshStatusBar();
		this.artifactStateEmitter.fire({ identity: document.identity, status });
	}

	private setDiagnostics(document: ArtifactDocument, items: readonly CompileDiagnostic[]): void {
		document.diagnostics = items;
		this.rebuildDiagnostics();
	}

	private onCloseTextDocument(document: TextDocument): void {
		if (!this.documents.has(documentKey(document.uri))) {
			return;
		}

		// Guard against race condition: if the user reopens the same assembly document quickly,
		// the delayed close event from the old document would destroy the new handler/decorator.
		// Only clean up if no tab still shows this document.
		const remainsOpen = window.tabGroups.all.some(group => group.tabs.some(tab =>
			tab.input instanceof TabInputText && tab.input.uri.toString() === document.uri.toString()));

		if (!remainsOpen) {
			this.unregisterDocument(document.uri);
		}
	}

	private unregisterDocument(uri: Uri): void {
		const key = documentKey(uri);
		const document = this.documents.get(key);
		if (!document) {
			return;
		}

		if (document.pendingRefresh) {
			clearTimeout(document.pendingRefresh);
		}
		document.watcher.dispose();
		document.decorator?.dispose();

		const assemblyUris = this.sourceToArtifacts.get(document.handler.sourceUri);
		assemblyUris?.delete(uri);
		if (assemblyUris?.size === 0) {
			this.sourceToArtifacts.delete(document.handler.sourceUri);
		}

		document.handler.dispose();
		this.documents.delete(key);
		this.rebuildDiagnostics();
		this.refreshStatusBar();
	}

	private activeArtifactDocument(): ArtifactDocument | undefined {
		const uri = window.activeTextEditor?.document.uri;
		return uri ? this.documents.get(documentKey(uri)) : undefined;
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
		const { status } = document.handler;
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
				this.statusBar.text = status.truncated
					? '$(warning) Truncated'
					: '$(error) Failed';
				break;
			case 'successful':
				this.statusBar.text = status.truncated
					? '$(warning) Truncated'
					: '$(check) Ready';
				break;
		}
		this.statusBar.tooltip = [
			`${document.identity.artifactLabel} · ${path.basename(document.identity.sourceLabel)}`,
			`${document.identity.variantLabel} · ${document.identity.toolchainLabel}`,
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
				const key = item.uri.toString();
				const group = grouped.get(key) ?? { uri: item.uri, diagnostics: [] };
				group.diagnostics.push(new Diagnostic(
					new Range(new Position(item.line, item.column), new Position(item.line, item.column + 1)),
					item.message,
					toDiagnosticSeverity(item.severity),
				));
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
		case 'warning': return DiagnosticSeverity.Warning;
		case 'information': return DiagnosticSeverity.Information;
		default: return DiagnosticSeverity.Error;
	}
}
