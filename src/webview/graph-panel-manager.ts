import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
	CancellationTokenSource,
	ColorThemeKind,
	Disposable,
	Event,
	EventEmitter,
	ExtensionContext,
	Position,
	Range,
	Uri,
	ViewColumn,
	WebviewPanel,
	window,
	workspace,
} from 'vscode';
import type { ConfigurationService } from '../services/configuration-service.js';
import type { CompilationService } from '../compilation/index.js';
import type {
	CompilationVariant,
	ControlFlowSourceLocation,
	RenderedGraphArtifact,
	ToolchainProfile,
} from '../types/index.js';
import {
	parseArtifactUri,
	type ArtifactUriIdentity,
} from '../asm-document/artifact-uri.js';
import { CompileHandler, type CompileHandlerStatus } from '../asm-document/compile-handler.js';
import type {
	ArtifactDocumentIdentity,
	ArtifactDocumentSnapshot,
} from '../asm-document/asm-provider.js';
import { toComparisonKey } from '../utils.js';
import { logChannel } from '../logger.js';
import { getArtifactOutputChoices } from '../toolchains/toolchain-map.js';
import {
	parseWebviewMessage,
	type GraphTheme,
	type HostMessage,
	type SerializedGraphArtifact,
} from './graph-protocol.js';

interface GraphPanelDocument {
	readonly key: string;
	readonly uri: Uri;
	readonly identity: ArtifactDocumentIdentity;
	readonly handler: CompileHandler;
	readonly panel: WebviewPanel;
	subscriptions: Disposable;
	artifact?: RenderedGraphArtifact;
	selectedGraphId?: string;
	pendingRefresh?: NodeJS.Timeout;
	ready: boolean;
}

export class GraphPanelManager implements Disposable {
	private readonly documents = new Map<string, GraphPanelDocument>();
	private readonly stateEmitter = new EventEmitter<ArtifactDocumentSnapshot>();
	private readonly activeEmitter = new EventEmitter<ArtifactDocumentSnapshot | undefined>();
	private readonly subscriptions: Disposable;
	private activeDocument?: GraphPanelDocument;

	readonly onDidChangeArtifactState: Event<ArtifactDocumentSnapshot> = this.stateEmitter.event;
	readonly onDidChangeActiveGraph: Event<ArtifactDocumentSnapshot | undefined> = this.activeEmitter.event;

	constructor(
		private readonly context: ExtensionContext,
		private readonly compilationService: CompilationService,
		configuration: ConfigurationService,
	) {
		this.subscriptions = Disposable.from(
			compilationService.onVariantsChanged(sources => {
				const changed = new Set(sources.map(source => source.toString()));
				for (const document of this.documents.values()) {
					if (changed.has(parseArtifactUri(document.uri)?.source.toString() ?? '')) {
						this.requestRefresh(document);
					}
				}
			}),
			compilationService.onArtifactOptionsChanged(kind => {
				if (kind === 'control-flow-graph') {
					this.documents.forEach(document => this.requestRefresh(document));
				}
			}),
			configuration.onDidChange(() => {
				this.documents.forEach(document => this.requestRefresh(document));
			}),
			window.onDidChangeActiveColorTheme(() => {
				this.documents.forEach(document => this.postTheme(document));
			}),
			this.stateEmitter,
			this.activeEmitter,
		);
	}

	get activeSnapshot(): ArtifactDocumentSnapshot | undefined {
		return this.activeDocument ? this.snapshot(this.activeDocument) : undefined;
	}

	async open(uri: Uri): Promise<void> {
		const key = panelKey(uri);
		const existing = this.documents.get(key);
		if (existing) {
			existing.panel.reveal(ViewColumn.Beside, true);
			this.setActive(existing);
			if (existing.handler.status.state === 'stale') {
				this.requestRefresh(existing);
			}
			return;
		}

		const parsed = parseArtifactUri(uri);
		if (
			!parsed
			|| parsed.artifactKind !== 'control-flow-graph'
			|| !parsed.artifactOutputId
		) {
			throw new Error(`Invalid control-flow graph URI: ${uri.toString()}`);
		}
		const variant = this.compilationService.getVariants(parsed.source)
			.find(candidate => candidate.id === parsed.variantId);
		if (!variant) {
			throw new Error(`Compilation variant is no longer available: ${parsed.variantId}`);
		}
		const profile = this.compilationService.toolchainRegistry
			.getToolchainById(variant.toolchainProfileId)?.profile;
		const artifactOutput = profile
			? getArtifactOutputChoices(profile, parsed.artifactKind)
				.find(output => output.id === parsed.artifactOutputId)
			: undefined;
		const identity = graphDocumentIdentity(uri, parsed, variant, profile);
		const panel = window.createWebviewPanel(
			'coglens.controlFlowGraph',
			`${path.basename(parsed.source.fsPath)} — ${artifactOutput?.label ?? parsed.artifactOutputId}`,
			{ viewColumn: ViewColumn.Beside, preserveFocus: true },
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [Uri.joinPath(this.context.extensionUri, 'dist', 'webview')],
			},
		);
		const handler = new CompileHandler(
			parsed.source,
			uri,
			variant,
			'control-flow-graph',
			parsed.presetId,
			this.compilationService,
			parsed.artifactOutputId,
		);
		const document: GraphPanelDocument = {
			key,
			uri,
			identity,
			handler,
			panel,
			ready: false,
			subscriptions: Disposable.from(),
		};
		panel.webview.html = this.html(panel);
		const subscriptions = Disposable.from(
			handler.onDidChange(status => this.acceptStatus(document, status)),
			panel.webview.onDidReceiveMessage(message => this.acceptMessage(document, message)),
			panel.onDidChangeViewState(event => {
				if (event.webviewPanel.active) {
					this.setActive(document);
				} else if (this.activeDocument === document) {
					this.setActive(undefined);
				}
			}),
			panel.onDidDispose(() => this.remove(document)),
		);
		document.subscriptions = subscriptions;
		this.documents.set(key, document);
		if (panel.active) {
			this.setActive(document);
		}
		this.stateEmitter.fire(this.snapshot(document));
		await this.refresh(document);
	}

	dispose(): void {
		this.subscriptions.dispose();
		for (const document of [...this.documents.values()]) {
			document.panel.dispose();
		}
		this.documents.clear();
	}

	private requestRefresh(document: GraphPanelDocument): void {
		document.handler.markStale();
		if (document.pendingRefresh) {
			clearTimeout(document.pendingRefresh);
		}
		document.pendingRefresh = setTimeout(() => {
			document.pendingRefresh = undefined;
			void this.refresh(document);
		}, 50);
	}

	private async refresh(document: GraphPanelDocument): Promise<void> {
		const cancellation = new CancellationTokenSource();
		try {
			await document.handler.update(cancellation.token);
		} catch {
			// CompileHandler publishes the retained/failure state used by the panel and details view.
		} finally {
			cancellation.dispose();
		}
	}

	private acceptStatus(document: GraphPanelDocument, status: CompileHandlerStatus): void {
		if (status.artifact?.presentation === 'graph') {
			document.artifact = status.artifact;
			if (!status.artifact.graphs.some(graph => graph.id === document.selectedGraphId)) {
				document.selectedGraphId = status.artifact.graphs[0]?.id;
			}
		}
		this.stateEmitter.fire(this.snapshot(document));
		if (this.activeDocument === document) {
			this.activeEmitter.fire(this.snapshot(document));
		}
		this.postRender(document, status);
	}

	private acceptMessage(document: GraphPanelDocument, value: unknown): void {
		const message = parseWebviewMessage(value);
		if (!message) {
			logChannel.debug('Ignored invalid control-flow graph webview message.');
			return;
		}
		switch (message.type) {
			case 'ready':
				document.ready = true;
				this.postTheme(document);
				this.postRender(document, document.handler.status);
				break;
			case 'selectionChanged':
				if (!document.artifact?.graphs.some(graph => graph.id === message.graphId)) {
					logChannel.debug('Ignored stale control-flow graph selection.');
					return;
				}
				document.selectedGraphId = message.graphId;
				break;
			case 'openSource': {
				const graph = document.artifact?.graphs.find(candidate => candidate.id === message.graphId);
				const node = graph?.nodes.find(candidate => candidate.id === message.nodeId);
				const source = node?.source;
				if (!source) {
					logChannel.debug('Ignored stale or unmapped control-flow graph source request.');
					return;
				}
				void openSource(source).catch(error => {
					logChannel.warn(`Could not open control-flow graph source ${source.uri}: ${String(error)}`);
				});
				break;
			}
		}
	}

	private postRender(document: GraphPanelDocument, status: CompileHandlerStatus): void {
		if (!document.ready) {
			return;
		}
		const retained = document.artifact;
		const artifact: SerializedGraphArtifact = {
			graphs: retained?.graphs ?? [],
			metrics: retained?.metrics ?? {},
			diagnostics: diagnosticMessages(status, retained),
			stale: status.state !== 'successful',
			...(status.state === 'failed' ? { failure: status.error.message } : {}),
		};
		this.postMessage(document, {
			type: 'render',
			artifact,
			...(document.selectedGraphId === undefined ? {} : { selectedGraphId: document.selectedGraphId }),
		});
	}

	private postTheme(document: GraphPanelDocument): void {
		if (!document.ready) {
			return;
		}
		const message: HostMessage = { type: 'theme', theme: currentTheme() };
		this.postMessage(document, message);
	}

	private postMessage(document: GraphPanelDocument, message: HostMessage): void {
		void document.panel.webview.postMessage(message).then(undefined, error => {
			logChannel.debug(`Control-flow graph panel message was not delivered: ${String(error)}`);
		});
	}

	private setActive(document: GraphPanelDocument | undefined): void {
		if (this.activeDocument === document) {
			return;
		}
		this.activeDocument = document;
		this.activeEmitter.fire(document ? this.snapshot(document) : undefined);
	}

	private snapshot(document: GraphPanelDocument): ArtifactDocumentSnapshot {
		return { identity: document.identity, status: document.handler.status };
	}

	private remove(document: GraphPanelDocument): void {
		if (this.documents.get(document.key) !== document) {
			return;
		}
		this.documents.delete(document.key);
		if (document.pendingRefresh) {
			clearTimeout(document.pendingRefresh);
			document.pendingRefresh = undefined;
		}
		document.subscriptions.dispose();
		document.handler.dispose();
		if (this.activeDocument === document) {
			this.setActive(undefined);
		}
	}

	private html(panel: WebviewPanel): string {
		const webview = panel.webview;
		const nonce = randomUUID().replaceAll('-', '');
		const script = webview.asWebviewUri(Uri.joinPath(
			this.context.extensionUri,
			'dist',
			'webview',
			'control-flow-graph.js',
		));
		const style = webview.asWebviewUri(Uri.joinPath(
			this.context.extensionUri,
			'dist',
			'webview',
			'control-flow-graph.css',
		));
		const csp = [
			"default-src 'none'",
			`img-src ${webview.cspSource} data:`,
			`style-src ${webview.cspSource}`,
			`script-src 'nonce-${nonce}'`,
		].join('; ');
		return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>Control-flow graph</title>
</head>
<body>
<div class="toolbar" role="toolbar" aria-label="Control-flow graph controls">
<label for="function-selector">Function</label>
<select id="function-selector" aria-label="Function"></select>
<button id="fit" type="button" title="Fit to view">Fit</button>
<button id="zoom-in" type="button" title="Zoom in" aria-label="Zoom in">+</button>
<button id="zoom-out" type="button" title="Zoom out" aria-label="Zoom out">−</button>
<button id="reset" type="button" title="Reset view">Reset</button>
<div class="spacer"></div>
<div class="legend" aria-label="Edge legend">
<span class="legend-item legend-true">True</span>
<span class="legend-item legend-false">False</span>
<span class="legend-item legend-fallthrough">Fallthrough</span>
<span class="legend-item legend-exception">Exception</span>
</div>
<span id="stale-badge" role="status" aria-live="polite" aria-atomic="true" hidden>Stale</span>
</div>
<div id="diagnostics" role="status" aria-live="polite" hidden></div>
<div id="graph-canvas" data-empty="true" aria-label="Control-flow graph canvas">
<div id="empty-state" role="status">No valid function graphs were found.</div>
<svg id="graph-svg" xmlns="http://www.w3.org/2000/svg" role="group" aria-label="Selected function control-flow graph">
<defs><marker id="arrowhead" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="context-stroke"></path></marker></defs>
<g id="graph-viewport"></g>
</svg>
</div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
	}
}

function graphDocumentIdentity(
	uri: Uri,
	parsed: ArtifactUriIdentity,
	variant: CompilationVariant,
	profile: ToolchainProfile | undefined,
): ArtifactDocumentIdentity {
	if (parsed.artifactKind !== 'control-flow-graph' || !parsed.artifactOutputId) {
		throw new Error('Control-flow graph identity requires an output selection.');
	}
	const artifactOutput = profile
		? getArtifactOutputChoices(profile, parsed.artifactKind)
			.find(output => output.id === parsed.artifactOutputId)
		: undefined;
	return {
		documentUri: uri.toString(),
		sourceUri: parsed.source.toString(),
		sourceLabel: parsed.source.fsPath,
		artifactKind: parsed.artifactKind,
		artifactLabel: artifactOutput?.label ?? parsed.artifactOutputId,
		artifactOutputId: parsed.artifactOutputId,
		artifactOutputLabel: artifactOutput?.label ?? parsed.artifactOutputId,
		presetId: parsed.presetId,
		variantId: variant.id,
		variantLabel: variant.displayLabel,
		toolchainId: profile?.id ?? variant.toolchainProfileId,
		toolchainLabel: profile?.displayName ?? variant.toolchainProfileId,
		toolchainKind: profile?.kind ?? 'unknown',
		renderedIdentity: uri.toString(),
	};
}

function diagnosticMessages(
	status: CompileHandlerStatus,
	artifact?: RenderedGraphArtifact,
): string[] {
	const messages = [
		...(artifact?.diagnostics ?? []).map(diagnostic => diagnostic.message),
		...(status.state === 'failed'
			? status.diagnostics.map(diagnostic => diagnostic.message)
			: []),
	];
	return [...new Set(messages)];
}

async function openSource(source: ControlFlowSourceLocation): Promise<void> {
	const uri = Uri.parse(source.uri, true);
	if (uri.scheme !== 'file' && uri.scheme !== 'vscode-remote') {
		return;
	}
	const document = await workspace.openTextDocument(uri);
	const start = new Position(source.line, source.column);
	const requestedEnd = new Position(source.endLine ?? source.line, source.endColumn ?? source.column);
	const selection = new Range(start, requestedEnd.isBefore(start) ? start : requestedEnd);
	const editor = await window.showTextDocument(document, {
		viewColumn: ViewColumn.One,
		preserveFocus: false,
		selection,
	});
	editor.revealRange(selection);
}

function currentTheme(): GraphTheme {
	switch (window.activeColorTheme.kind) {
		case ColorThemeKind.Light: return 'light';
		case ColorThemeKind.Dark: return 'dark';
		default: return 'high-contrast';
	}
}

function panelKey(uri: Uri): string {
	return toComparisonKey(uri, true, process.platform === 'win32');
}
