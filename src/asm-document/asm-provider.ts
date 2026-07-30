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
import { CompilationService } from '../compilation/index.js';
import type { ConfigurationService } from '../services/configuration-service.js';
import {
	CompilationError,
	type CompileDiagnostic,
	type RenderedArtifact,
} from '../types/index.js';
import { toComparisonKey } from '../utils.js';
import { sourceUriMap, sourceUriSet, UriSet } from '../uri-containers.js';
import {
	artifactScheme,
	getArtifactUri,
	parseArtifactUri,
} from './artifact-uri.js';
import { AsmDecorator } from './asm-decorator.js';
import { getContent, type CompiledAssembly } from './compiled-assembly.js';
import { CompileHandler } from './compile-handler.js';
import type { CompileHandlerStatus } from './compile-handler.js';

interface ArtifactDocument {
	readonly handler: CompileHandler;
	readonly watcher: Disposable;
	decorator?: AsmDecorator;
	assembly?: CompiledAssembly;
	pendingRefresh?: ReturnType<typeof setTimeout>;
	diagnostics: readonly CompileDiagnostic[];
}

function documentKey(uri: Uri): string {
	return toComparisonKey(uri, true, process.platform === 'win32');
}

export class AsmProvider implements TextDocumentContentProvider, Disposable {
	static readonly scheme = artifactScheme;

	private readonly documents = new Map<string, ArtifactDocument>();
	private readonly sourceToAssembly = sourceUriMap<UriSet>();
	private readonly changeEmitter = new EventEmitter<Uri>();
	private readonly diagnostics: DiagnosticCollection = languages.createDiagnosticCollection('coglens');
	private readonly statusBar: StatusBarItem = window.createStatusBarItem(StatusBarAlignment.Right, 1000);
	private readonly subscriptions: Disposable[];

	constructor(
		private readonly compilationService: CompilationService,
		private readonly configuration: ConfigurationService,
	) {
		this.subscriptions = [
			workspace.onDidCloseTextDocument(document => this.onCloseTextDocument(document)),
			compilationService.onVariantsChanged(sources => {
				for (const source of sources) {
					for (const assembly of this.sourceToAssembly.get(source)?.values() ?? []) {
						this.requestRefresh(assembly);
					}
				}
			}),
			compilationService.onArtifactOptionsChanged(() => {
				for (const document of this.documents.values()) {
					this.requestRefresh(document.handler.asmUri);
				}
			}),
			configuration.onDidChange(() => {
				for (const document of this.documents.values()) {
					this.requestRefresh(document.handler.asmUri);
				}
			}),
			this.changeEmitter,
			this.diagnostics,
			this.statusBar,
		];
	}

	// Implements TextDocumentContentProvider.provideTextDocumentContent. This function will be called for the given
	// Uri when onDidChange(Uri) is fired. onDidChange will be fired when a source document changes and is recompiled
	// (or fails to recompile).
	provideTextDocumentContent(uri: Uri, token: CancellationToken): ProviderResult<string> {
		const document = this.getOrCreateDocument(uri);
		const handler = document.handler;

		if (!document.decorator) {
			document.decorator = new AsmDecorator(
				handler.srcUri,
				handler.asmUri,
				handler.onDidChange,
				this.configuration,
			);
		}

		const compilation = handler.update(token);

		return compilation.then(({ assembly, artifact }) => {
			document.assembly = assembly;
			this.setDiagnostics(document, artifact.raw.diagnostics);

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

	getCompiledAssembly(uri: Uri): CompiledAssembly | undefined {
		return this.documents.get(documentKey(uri))?.assembly;
	}

	getRenderedArtifact(uri: Uri): RenderedArtifact | undefined {
		return this.documents.get(documentKey(uri))?.handler.status.artifact;
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
		const handler = new CompileHandler(
			identity.source,
			assemblyUri,
			variant,
			identity.artifactKind,
			identity.presetId,
			this.compilationService,
		);

		let assemblyUris = this.sourceToAssembly.get(identity.source);
		if (!assemblyUris) {
			assemblyUris = sourceUriSet();
			this.sourceToAssembly.set(identity.source, assemblyUris);
		}
		assemblyUris.add(assemblyUri);

		const watcher = workspace.createFileSystemWatcher(new RelativePattern(
			Uri.file(path.dirname(identity.source.fsPath)),
			path.basename(identity.source.fsPath),
		));
		const document: ArtifactDocument = {
			handler,
			watcher: Disposable.from(
				watcher,
				watcher.onDidChange(() => this.requestRefresh(assemblyUri)),
				handler.onDidChange(status => this.onHandlerStatus(assemblyUri, status)),
			),
			diagnostics: [],
		};
		this.documents.set(key, document);

		return document;
	}

	private onHandlerStatus(assemblyUri: Uri, status: CompileHandlerStatus): void {
		const document = this.documents.get(documentKey(assemblyUri));
		if (!document) {
			return;
		}
		if (status.state === 'successful') {
			document.assembly = status.assembly;
		} else if (status.state === 'failed') {
			document.assembly = undefined;
		}
		this.updateStatusBar(document.handler, status);
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

		const assemblyUris = this.sourceToAssembly.get(document.handler.srcUri);
		assemblyUris?.delete(uri);
		if (assemblyUris?.size === 0) {
			this.sourceToAssembly.delete(document.handler.srcUri);
		}

		document.handler.dispose();
		this.documents.delete(key);
		this.rebuildDiagnostics();
		if (this.documents.size === 0) {
			this.statusBar.hide();
		}
	}

	private updateStatusBar(handler: CompileHandler, status: CompileHandlerStatus): void {
		const sourceName = path.basename(handler.srcUri.fsPath);
		switch (status.state) {
			case 'compiling':
				this.statusBar.text = `$(sync~spin) Cogitator Lens: Compiling ${sourceName}`;
				break;
			case 'stale':
				this.statusBar.text = `$(history) Cogitator Lens: Stale ${sourceName}`;
				break;
			case 'failed':
				this.statusBar.text = status.truncated
					? `$(warning) Cogitator Lens: Truncated ${sourceName}`
					: `$(error) Cogitator Lens: Failed ${sourceName}`;
				break;
			case 'successful':
				this.statusBar.text = status.truncated
					? `$(warning) Cogitator Lens: Truncated ${sourceName}`
					: `$(check) Cogitator Lens: Ready ${sourceName}`;
				break;
		}
		this.statusBar.tooltip = status.state === 'failed'
			? status.error.message
			: `Artifact state: ${status.state}`;
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
