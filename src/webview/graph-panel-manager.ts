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
	Selection,
	Uri,
	ViewColumn,
	WebviewPanel,
	window,
	workspace,
} from 'vscode';
import { localFileUriComparisonKey } from '../local-file-identity.js';
import type { ControlFlowGraph, ControlFlowSourceLocation, RenderedGraphArtifact } from '../types/index.js';
import type { ArtifactStatus } from '../artifact-document/artifact-generator.js';
import type { ArtifactDocumentSnapshot } from '../artifact-document/artifact-identity.js';
import {
	artifactDocumentKey,
	ArtifactDocumentRegistry,
	type ArtifactRegistryDocument,
} from '../artifact-document/artifact-document-registry.js';
import { logChannel } from '../logger.js';
import { artifactDefinitions } from '../artifacts/core/artifact-definitions.js';
import {
	parseWebviewMessage,
	type GraphTheme,
	type HostMessage,
	type SerializedGraphArtifact,
} from './graph-protocol.js';

interface GraphPanelDocument {
	readonly registered: ArtifactRegistryDocument;
	readonly panel: WebviewPanel;
	subscriptions: Disposable;
	artifact?: RenderedGraphArtifact;
	selectedGraphId?: string;
	ready: boolean;
}

export class GraphPanelManager implements Disposable {
	private readonly documents = new Map<string, GraphPanelDocument>();
	private readonly activeEmitter = new EventEmitter<ArtifactDocumentSnapshot | undefined>();
	private readonly subscriptions: Disposable;
	private activeDocument?: GraphPanelDocument;

	readonly onDidChangeActiveGraph: Event<ArtifactDocumentSnapshot | undefined> = this.activeEmitter.event;

	constructor(
		private readonly context: ExtensionContext,
		private readonly registry: ArtifactDocumentRegistry,
	) {
		this.subscriptions = Disposable.from(
			window.onDidChangeActiveColorTheme(() => {
				this.documents.forEach((document) => this.postTheme(document));
			}),
			this.activeEmitter,
		);
	}

	get activeSnapshot(): ArtifactDocumentSnapshot | undefined {
		return this.activeDocument ? this.snapshot(this.activeDocument) : undefined;
	}

	get onDidChangeArtifactState(): Event<ArtifactDocumentSnapshot> {
		return this.registry.onDidChangeArtifactState;
	}

	async open(uri: Uri): Promise<void> {
		const key = artifactDocumentKey(uri);
		const existing = this.documents.get(key);
		if (existing) {
			existing.panel.reveal(ViewColumn.Beside, true);
			this.setActive(existing);
			if (existing.registered.handler.status.state === 'stale') {
				this.requestRefresh(existing);
			}
			return;
		}

		const registered = this.registry.open(uri, {
			refresh: (registryDocument) => {
				const current = this.documents.get(artifactDocumentKey(registryDocument.uri));
				if (current) {
					void this.refresh(current);
				}
			},
			onStatus: (registryDocument, status) => {
				const current = this.documents.get(artifactDocumentKey(registryDocument.uri));
				if (current) {
					this.acceptStatus(current, status);
				}
			},
		});
		const parsed = registered.parsed;
		const definition = artifactDefinitions[parsed.artifactKind];
		if (
			definition.presentation !== 'graph' ||
			definition.requiresOutputSelection !== true ||
			!parsed.artifactOutputId
		) {
			this.registry.unregister(uri);
			throw new Error(`Invalid control-flow graph URI: ${uri.toString()}`);
		}
		const panel = window.createWebviewPanel(
			'coglens.controlFlowGraph',
			`${path.basename(parsed.source.fsPath)} — ${registered.identity.artifactOutputLabel ?? parsed.artifactOutputId}`,
			{ viewColumn: ViewColumn.Beside, preserveFocus: true },
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [Uri.joinPath(this.context.extensionUri, 'dist', 'webview')],
			},
		);
		const document: GraphPanelDocument = {
			registered,
			panel,
			ready: false,
			subscriptions: Disposable.from(),
		};
		panel.webview.html = this.html(panel);
		const subscriptions = Disposable.from(
			panel.webview.onDidReceiveMessage((message) => this.acceptMessage(document, message)),
			panel.onDidChangeViewState((event) => {
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
		this.registry.requestRefresh(document.registered.uri);
	}

	private async refresh(document: GraphPanelDocument): Promise<void> {
		const cancellation = new CancellationTokenSource();
		try {
			await document.registered.handler.update(cancellation.token);
		} catch {
			// ArtifactGenerator publishes the retained/failure state used by the panel and details view.
		} finally {
			cancellation.dispose();
		}
	}

	private acceptStatus(document: GraphPanelDocument, status: ArtifactStatus): void {
		if (status.artifact?.presentation === 'graph') {
			document.artifact = status.artifact;
			if (!status.artifact.graphs.some((graph) => graph.id === document.selectedGraphId)) {
				document.selectedGraphId = status.artifact.graphs[0]?.id;
			}
		}
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
				this.postRender(document, document.registered.handler.status);
				break;
			case 'selectionChanged':
				if (!document.artifact?.graphs.some((graph) => graph.id === message.graphId)) {
					logChannel.debug('Ignored stale control-flow graph selection.');
					return;
				}
				document.selectedGraphId = message.graphId;
				break;
			case 'refresh':
				this.requestRefresh(document);
				break;
			case 'exportDot': {
				const graph = document.artifact?.graphs.find((candidate) => candidate.id === message.graphId);
				if (graph) {
					void this.saveExport(document, graph.label, 'dot', toDot(graph));
				}
				break;
			}
			case 'exportSvg': {
				const graph = document.artifact?.graphs.find((candidate) => candidate.id === message.graphId);
				if (graph) {
					void this.saveExport(document, graph.label, 'svg', message.svg);
				}
				break;
			}
			case 'openSource': {
				const graph = document.artifact?.graphs.find((candidate) => candidate.id === message.graphId);
				const node = graph?.nodes.find((candidate) => candidate.id === message.nodeId);
				const source = node?.source;
				if (!source) {
					logChannel.debug('Ignored stale or unmapped control-flow graph source request.');
					return;
				}
				void openSource(source).catch((error) => {
					logChannel.warn(`Could not open control-flow graph source ${source.uri}: ${String(error)}`);
				});
				break;
			}
			case 'highlightSource': {
				const graph = document.artifact?.graphs.find((candidate) => candidate.id === message.graphId);
				const source = graph?.nodes.find((candidate) => candidate.id === message.nodeId)?.source;
				if (source) {
					highlightVisibleSource(source);
				}
				break;
			}
		}
	}

	private async saveExport(
		document: GraphPanelDocument,
		label: string,
		extension: 'dot' | 'svg',
		contents: string,
	): Promise<void> {
		const uri = await window.showSaveDialog({
			title: `Export ${label} control-flow graph`,
			defaultUri: exportUri(document.registered.identity.sourceUri, `${safeFilename(label)}.${extension}`),
			filters: extension === 'svg' ? { SVG: ['svg'] } : { Graphviz: ['dot'] },
		});
		if (!uri) {
			return;
		}
		try {
			await workspace.fs.writeFile(uri, new TextEncoder().encode(contents));
		} catch (error) {
			void window.showErrorMessage(`Could not export control-flow graph: ${String(error)}`);
		}
	}

	private postRender(document: GraphPanelDocument, status: ArtifactStatus): void {
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
		void document.panel.webview.postMessage(message).then(undefined, (error) => {
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
		return { identity: document.registered.identity, status: document.registered.handler.status };
	}

	private remove(document: GraphPanelDocument): void {
		const key = artifactDocumentKey(document.registered.uri);
		if (this.documents.get(key) !== document) {
			return;
		}
		this.documents.delete(key);
		document.subscriptions.dispose();
		this.registry.unregister(document.registered.uri);
		if (this.activeDocument === document) {
			this.setActive(undefined);
		}
	}

	private html(panel: WebviewPanel): string {
		const webview = panel.webview;
		const nonce = randomUUID().replaceAll('-', '');
		const script = webview.asWebviewUri(
			Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'control-flow-graph.js'),
		);
		const style = webview.asWebviewUri(
			Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'control-flow-graph.css'),
		);
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
<div class="function-picker">
<input id="function-selector" autocomplete="off" role="combobox" aria-label="Function" aria-controls="function-options" aria-expanded="false" placeholder="Filter functions">
<div id="function-options" role="listbox" hidden></div>
</div>
<input id="graph-search" type="search" aria-label="Find in graph" placeholder="Find instruction or register">
<label for="layout-direction">Layout</label>
<select id="layout-direction" aria-label="Graph layout direction"><option value="TB">Top to bottom</option><option value="LR">Left to right</option></select>
<button id="fit" type="button" title="Fit to view">Fit</button>
<button id="zoom-in" type="button" title="Zoom in" aria-label="Zoom in">+</button>
<button id="zoom-out" type="button" title="Zoom out" aria-label="Zoom out">−</button>
<button id="reset" type="button" title="Reset view">Reset</button>
<button id="export-svg" type="button" title="Export SVG">SVG</button>
<button id="export-dot" type="button" title="Export Graphviz DOT">DOT</button>
<div class="spacer"></div>
<button id="legend-toggle" type="button" aria-expanded="false" aria-controls="edge-legend">Legend</button>
<div id="edge-legend" class="legend" aria-label="Edge legend" hidden>
<span class="legend-item legend-true">True</span>
<span class="legend-item legend-false">False</span>
<span class="legend-item legend-fallthrough">Fallthrough</span>
<span class="legend-item legend-exception">Exception</span>
</div>
<button id="stale-badge" type="button" title="Refresh graph" aria-label="Refresh stale graph" hidden>Stale · Refresh</button>
</div>
<details id="diagnostics" role="status" aria-live="polite" hidden><summary>Diagnostics</summary><div id="diagnostic-list"></div></details>
<div id="graph-canvas" data-empty="true" aria-label="Control-flow graph canvas">
<div id="empty-state" role="status">No valid function graphs were found.</div>
<svg id="minimap" aria-label="Graph overview" viewBox="0 0 160 110"><g id="minimap-content"></g></svg>
<aside id="node-details" role="status" aria-live="polite" hidden><button id="close-node-details" type="button" aria-label="Close block details">×</button><strong id="node-details-title"></strong><pre id="node-details-text"></pre><button id="open-node-source" type="button" hidden>Open source</button></aside>
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

function toDot(graph: ControlFlowGraph): string {
	const quote = (value: string): string => JSON.stringify(value);
	const nodes = graph.nodes.map((node) => `  ${quote(node.id)} [label=${quote(node.label)}];`);
	const edges = graph.edges.map(
		(edge) => `  ${quote(edge.from)} -> ${quote(edge.to)} [label=${quote(edge.label ?? edge.kind)}];`,
	);
	return `digraph ${quote(graph.label)} {\n  rankdir=TB;\n  node [shape=box, fontname="monospace"];\n${nodes.join('\n')}\n${edges.join('\n')}\n}\n`;
}

function safeFilename(value: string): string {
	return value.replace(/[<>:"/\\|?*\x00-\x1F]/g, '-').trim() || 'control-flow-graph';
}

function exportUri(sourceUri: string, filename: string): Uri | undefined {
	try {
		const source = Uri.parse(sourceUri, true);
		return Uri.joinPath(source.with({ path: source.path.replace(/\/[^/]*$/u, '') }), filename);
	} catch {
		return undefined;
	}
}

function diagnosticMessages(status: ArtifactStatus, artifact?: RenderedGraphArtifact): string[] {
	const messages = [
		...(artifact?.diagnostics ?? []).map((diagnostic) => diagnostic.message),
		...(status.state === 'failed' ? status.diagnostics.map((diagnostic) => diagnostic.message) : []),
	];
	return [...new Set(messages)];
}

async function openSource(source: ControlFlowSourceLocation): Promise<void> {
	let uri = Uri.parse(source.uri, true);
	if (uri.scheme !== 'file' && uri.scheme !== 'vscode-remote') {
		return;
	}
	const sourceKey = localFileUriComparisonKey(uri);
	const visible = window.visibleTextEditors.find(
		(candidate) => localFileUriComparisonKey(candidate.document.uri) === sourceKey,
	);
	uri = visible?.document.uri ?? uri;
	const document = visible?.document ?? (await workspace.openTextDocument(uri));
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

function highlightVisibleSource(source: ControlFlowSourceLocation): void {
	const uri = Uri.parse(source.uri, true);
	const sourceKey = localFileUriComparisonKey(uri);
	const editor = window.visibleTextEditors.find(
		(candidate) => localFileUriComparisonKey(candidate.document.uri) === sourceKey,
	);
	if (!editor) {
		return;
	}
	const start = new Position(source.line, source.column);
	const requestedEnd = new Position(source.endLine ?? source.line, source.endColumn ?? source.column);
	editor.selection = new Selection(start, requestedEnd.isBefore(start) ? start : requestedEnd);
	editor.revealRange(editor.selection);
}

function currentTheme(): GraphTheme {
	switch (window.activeColorTheme.kind) {
		case ColorThemeKind.Light:
			return 'light';
		case ColorThemeKind.Dark:
			return 'dark';
		default:
			return 'high-contrast';
	}
}
