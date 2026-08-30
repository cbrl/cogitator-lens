import { graphlib, layout } from '@dagrejs/dagre';
import type {
	ControlFlowEdge,
	ControlFlowGraph,
	ControlFlowNode,
} from '../src/types/index.js';
import { analyzeGraphStructure } from '../src/artifacts/control-flow-graph/graph-structure.js';
import {
	parseHostMessage,
	type HostMessage,
	type SerializedGraphArtifact,
	type WebviewMessage,
} from '../src/webview/graph-protocol.js';

interface PersistedState {
	readonly selectedGraphId?: string;
	readonly viewport?: Viewport;
}

interface Viewport {
	readonly x: number;
	readonly y: number;
	readonly scale: number;
}

interface VsCodeApi {
	postMessage(message: WebviewMessage): void;
	getState(): PersistedState | undefined;
	setState(state: PersistedState): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();
const namespace = 'http://www.w3.org/2000/svg';
const selector = requiredElement<HTMLInputElement>('function-selector');
const functionOptions = requiredElement<HTMLDivElement>('function-options');
const graphSearch = requiredElement<HTMLInputElement>('graph-search');
const layoutDirection = requiredElement<HTMLSelectElement>('layout-direction');
const canvas = requiredElement<HTMLDivElement>('graph-canvas');
const diagnostics = requiredElement<HTMLDetailsElement>('diagnostics');
const diagnosticList = requiredElement<HTMLDivElement>('diagnostic-list');
const staleBadge = requiredElement<HTMLButtonElement>('stale-badge');
const emptyState = requiredElement<HTMLDivElement>('empty-state');
const svg = requiredElement<SVGSVGElement>('graph-svg');
const viewportGroup = requiredElement<SVGGElement>('graph-viewport');
const minimap = requiredElement<SVGSVGElement>('minimap');
const minimapContent = requiredElement<SVGGElement>('minimap-content');
const nodeDetails = requiredElement<HTMLElement>('node-details');
const nodeDetailsTitle = requiredElement<HTMLElement>('node-details-title');
const nodeDetailsText = requiredElement<HTMLElement>('node-details-text');
const openNodeSource = requiredElement<HTMLButtonElement>('open-node-source');
let artifact: SerializedGraphArtifact | undefined;
let currentGraph: ControlFlowGraph | undefined;
let viewport: Viewport = vscode.getState()?.viewport ?? { x: 24, y: 24, scale: 1 };
let graphBounds = { width: 1, height: 1 };
let pointer: { x: number; y: number; origin: Viewport; dragging: boolean } | undefined;
/** Set when a drag ends, so the click it synthesizes does not open a source. */
let suppressClick = false;
let selectedNode: ControlFlowNode | undefined;
let focusedNodeId: string | undefined;
let rankDirection: 'TB' | 'LR' = 'TB';
const dragThreshold = 4;

selector.addEventListener('change', selectNamedGraph);
selector.addEventListener('focus', () => {
	selector.value = '';
	renderFunctionOptions();
});
selector.addEventListener('input', renderFunctionOptions);
selector.addEventListener('blur', () => {
	window.setTimeout(() => {
		if (!selector.value && currentGraph) {
			selector.value = currentGraph.label;
		}
		hideFunctionOptions();
	}, 120);
});
selector.addEventListener('keydown', event => {
	if (event.key === 'Enter') {
		event.preventDefault();
		selectNamedGraph();
	}
	if (event.key === 'Escape') {
		hideFunctionOptions();
	}
});
graphSearch.addEventListener('input', applySearch);
layoutDirection.addEventListener('change', () => {
	rankDirection = layoutDirection.value === 'LR' ? 'LR' : 'TB';
	if (currentGraph) {
		viewportGroup.replaceChildren();
		drawGraph(currentGraph);
		applySearch();
		fitToView();
	}
});
requiredElement<HTMLButtonElement>('fit').addEventListener('click', fitToView);
requiredElement<HTMLButtonElement>('zoom-in').addEventListener('click', () => zoomBy(1.2));
requiredElement<HTMLButtonElement>('zoom-out').addEventListener('click', () => zoomBy(1 / 1.2));
requiredElement<HTMLButtonElement>('reset').addEventListener('click', resetViewport);
requiredElement<HTMLButtonElement>('export-svg').addEventListener('click', exportSvg);
requiredElement<HTMLButtonElement>('export-dot').addEventListener('click', () => {
	if (currentGraph) {
		vscode.postMessage({ type: 'exportDot', graphId: currentGraph.id });
	}
});
requiredElement<HTMLButtonElement>('legend-toggle').addEventListener('click', toggleLegend);
staleBadge.addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
requiredElement<HTMLButtonElement>('close-node-details').addEventListener('click', () => {
	nodeDetails.hidden = true;
});
openNodeSource.addEventListener('click', () => {
	if (currentGraph && selectedNode) {
		openSource(currentGraph.id, selectedNode);
	}
});

canvas.addEventListener('wheel', event => {
	event.preventDefault();
	zoomBy(event.deltaY < 0 ? 1.1 : 1 / 1.1, event.offsetX, event.offsetY);
}, { passive: false });
canvas.addEventListener('pointerdown', event => {
	if (event.button !== 0) {
		return;
	}
	// Pointer capture is deliberately not taken here. While a capture is
	// active the click it produces is retargeted to the capturing element, so
	// capturing on every press would stop nodes from ever receiving a click.
	// Capture starts only once the pointer has actually moved into a drag.
	suppressClick = false;
	pointer = { x: event.clientX, y: event.clientY, origin: viewport, dragging: false };
});
canvas.addEventListener('pointermove', event => {
	if (!pointer) {
		return;
	}
	const deltaX = event.clientX - pointer.x;
	const deltaY = event.clientY - pointer.y;
	if (!pointer.dragging) {
		if (Math.abs(deltaX) < dragThreshold && Math.abs(deltaY) < dragThreshold) {
			return;
		}
		pointer.dragging = true;
		canvas.setPointerCapture(event.pointerId);
		canvas.classList.add('dragging');
	}
	viewport = { ...viewport, x: pointer.origin.x + deltaX, y: pointer.origin.y + deltaY };
	applyViewport();
});
canvas.addEventListener('pointerup', finishDrag);
canvas.addEventListener('pointercancel', finishDrag);

window.addEventListener('message', event => {
	const message = parseHostMessage(event.data);
	if (!message) {
		return;
	}
	handleHostMessage(message);
});

vscode.postMessage({ type: 'ready' });

function handleHostMessage(message: HostMessage): void {
	if (message.type === 'theme') {
		document.body.dataset.theme = message.theme;
		return;
	}
	artifact = message.artifact;
	staleBadge.hidden = !artifact.stale;
	renderDiagnostics(artifact);
	const priorState = vscode.getState();
	const previous = message.selectedGraphId
		?? priorState?.selectedGraphId
		?? selector.value;
	const selected = artifact.graphs.find(graph => graph.id === previous)
		?? artifact.graphs[0];
	selector.disabled = artifact.graphs.length < 2;
	if (!selected) {
		currentGraph = undefined;
		viewportGroup.replaceChildren();
		canvas.dataset.empty = 'true';
		emptyState.hidden = false;
		return;
	}
	selector.value = selected.label;
	renderFunctionOptions();
	hideFunctionOptions();
	selectGraph(selected.id, false, priorState?.selectedGraphId !== selected.id);
}

function selectNamedGraph(): void {
	const graph = artifact?.graphs.find(candidate =>
		candidate.label === selector.value || candidate.id === selector.value);
	if (graph) {
		selectGraph(graph.id, true, true);
	}
	hideFunctionOptions();
}

function renderFunctionOptions(): void {
	const query = selector.value.trim().toLocaleLowerCase();
	const matching = (artifact?.graphs ?? []).filter(graph =>
		!query || graph.label.toLocaleLowerCase().includes(query) || graph.id.toLocaleLowerCase().includes(query));
	functionOptions.replaceChildren(...matching.map(graph => {
		const option = document.createElement('button');
		option.type = 'button';
		option.className = 'function-option';
		option.role = 'option';
		option.textContent = graph.label;
		option.title = graph.id;
		option.addEventListener('pointerdown', event => {
			event.preventDefault();
			chooseFunction(graph);
		});
		option.addEventListener('click', () => chooseFunction(graph));
		return option;
	}));
	functionOptions.hidden = matching.length === 0;
	selector.setAttribute('aria-expanded', String(!functionOptions.hidden));
}

function chooseFunction(graph: ControlFlowGraph): void {
	selector.value = graph.label;
	selectGraph(graph.id, true, true);
	hideFunctionOptions();
}

function hideFunctionOptions(): void {
	functionOptions.hidden = true;
	selector.setAttribute('aria-expanded', 'false');
}

function selectGraph(graphId: string, notifyHost: boolean, fit: boolean): void {
	const graph = artifact?.graphs.find(candidate => candidate.id === graphId);
	if (!graph) {
		return;
	}
	currentGraph = graph;
	selectedNode = undefined;
	focusedNodeId = graph.entryNodeId ?? graph.nodes[0]?.id;
	nodeDetails.hidden = true;
	canvas.dataset.empty = 'false';
	emptyState.hidden = true;
	canvas.dataset.laidOutGraphId = graph.id;
	viewportGroup.replaceChildren();
	drawGraph(graph);
	applySearch();
	const prior = vscode.getState();
	vscode.setState({ ...prior, selectedGraphId: graph.id, viewport });
	if (notifyHost) {
		vscode.postMessage({ type: 'selectionChanged', graphId: graph.id });
	}
	if (fit) {
		requestAnimationFrame(fitToView);
	} else {
		applyViewport();
	}
}

/** Basic-block text is code: it is laid out left-aligned in the editor font. */
const nodePaddingX = 12;
const nodePaddingY = 10;
const maximumLabelColumns = 96;

/**
 * Measures the editor font once so node boxes fit their text. The font comes
 * from the user's VS Code theme, so its size cannot be assumed.
 */
const labelMetrics = ((): { characterWidth: number; lineHeight: number } => {
	const probe = svgElement('text', { class: 'node-label', x: '0', y: '0' });
	const sample = '0'.repeat(40);
	probe.textContent = sample;
	viewportGroup.append(probe);
	const measured = probe.getComputedTextLength() / sample.length;
	const fontSize = Number.parseFloat(getComputedStyle(probe).fontSize);
	probe.remove();
	return {
		characterWidth: measured > 0 ? measured : 7.1,
		lineHeight: Number.isFinite(fontSize) && fontSize > 0 ? Math.round(fontSize * 1.25) : 17,
	};
})();

/** Splits a node label into display lines, clipping columns no node should exceed. */
function labelLines(label: string): string[] {
	return label
		.split(/\r?\n/)
		.map(line => line.length > maximumLabelColumns
			? `${line.slice(0, maximumLabelColumns - 1)}…`
			: line);
}

function nodeSize(lines: readonly string[]): { width: number; height: number } {
	const columns = Math.max(...lines.map(line => line.length), 1);
	return {
		width: Math.max(150, nodePaddingX * 2 + columns * labelMetrics.characterWidth),
		height: Math.max(40, nodePaddingY * 2 + lines.length * labelMetrics.lineHeight),
	};
}

function drawGraph(graph: ControlFlowGraph): void {
	const structure = analyzeGraphStructure(graph);
	const layoutGraph = new graphlib.Graph({ multigraph: true })
		.setGraph({ rankdir: rankDirection, ranksep: 54, nodesep: 36, edgesep: 18, marginx: 20, marginy: 20 })
		.setDefaultEdgeLabel(() => ({}));
	for (const node of graph.nodes) {
		layoutGraph.setNode(node.id, nodeSize(labelLines(node.label)));
	}
	graph.edges.forEach((edge, index) => {
		layoutGraph.setEdge(edge.from, edge.to, {
			width: edge.label ? Math.min(260, 12 + edge.label.length * 6.5) : 0,
			height: edge.label ? 20 : 0,
			edge,
		}, `edge-${index}`);
	});
	layout(layoutGraph);
	const bounds = layoutGraph.graph();
	graphBounds = { width: bounds.width ?? 1, height: bounds.height ?? 1 };

	const edgeLayer = svgElement('g', { class: 'edges' });
	for (const edgeRef of layoutGraph.edges()) {
		const positioned = layoutGraph.edge(edgeRef);
		const edge = positioned.edge as ControlFlowEdge;
		const path = svgElement('path', {
			class: `edge edge-${edge.kind}${structure.backEdges.has(edge) ? ' back-edge' : ''}`,
			d: pointsPath(positioned.points ?? []),
			'marker-end': 'url(#arrowhead)',
			'data-from': edge.from,
			'data-to': edge.to,
		});
		edgeLayer.append(path);
		if (edge.label) {
			const label = svgElement('text', {
				class: `edge-label edge-${edge.kind}`,
				x: String(positioned.x ?? midpoint(positioned.points ?? []).x),
				y: String(positioned.y ?? midpoint(positioned.points ?? []).y),
			});
			label.textContent = edge.label;
			edgeLayer.append(label);
		}
	}
	viewportGroup.append(edgeLayer);

	const nodeLayer = svgElement('g', { class: 'nodes' });
	for (const node of graph.nodes) {
		const position = layoutGraph.node(node.id);
		if (!position) {
			continue;
		}
		const group = svgElement('g', {
			class: `node${node.terminal ? ` terminal terminal-${node.terminal}` : ''}${node.source ? ' source-linked' : ''}${structure.loopNodes.has(node.id) ? ' loop-node' : ''}${!structure.reachable.has(node.id) ? ' unreachable' : ''}`,
			transform: `translate(${position.x},${position.y})`,
			role: 'button',
			tabindex: node.id === focusedNodeId ? '0' : '-1',
			'aria-label': nodeDescription(node),
			'data-node-id': node.id,
		});
		group.append(svgElement('rect', {
			x: String(-position.width / 2),
			y: String(-position.height / 2),
			width: String(position.width),
			height: String(position.height),
			rx: '7',
		}));
		const lines = labelLines(node.label);
		const text = svgElement('text', { class: 'node-label', 'text-anchor': 'start' });
		const left = String(-position.width / 2 + nodePaddingX);
		const firstBaseline = -position.height / 2 + nodePaddingY + labelMetrics.lineHeight * 0.8;
		lines.forEach((line, index) => {
			const span = svgElement('tspan', {
				x: left,
				...(index === 0
					? { y: String(firstBaseline) }
					: { dy: String(labelMetrics.lineHeight) }),
			});
			span.textContent = line;
			text.append(span);
		});
		group.append(text);
		const title = svgElement('title', {});
		title.textContent = node.label;
		group.append(title);
		group.addEventListener('click', () => {
			if (!suppressClick) {
				selectNode(graph, node);
			}
		});
		group.addEventListener('dblclick', () => openSource(graph.id, node));
		group.addEventListener('mouseenter', () => emphasize(node.id));
		group.addEventListener('mouseleave', () => emphasize(undefined));
		group.addEventListener('focus', () => {
			focusedNodeId = node.id;
		});
		group.addEventListener('keydown', event => navigateGraph(event, graph, node));
		nodeLayer.append(group);
	}
	viewportGroup.append(nodeLayer);
	renderMinimap();
}

function renderDiagnostics(value: SerializedGraphArtifact): void {
	const messages = [
		...(value.failure ? [`Refresh failed: ${value.failure}`] : []),
		...value.diagnostics,
	];
	diagnosticList.replaceChildren(...messages.map(message => {
		const row = document.createElement('div');
		row.className = value.failure && messages[0] === message
			? 'diagnostic error'
			: /\bwarning\b/iu.test(message) ? 'diagnostic warning' : 'diagnostic';
		row.textContent = message;
		return row;
	}));
	const summary = diagnostics.querySelector('summary');
	if (summary) {
		summary.textContent = `Diagnostics (${messages.length})`;
	}
	diagnostics.hidden = messages.length === 0;
}

function selectNode(graph: ControlFlowGraph, node: ControlFlowNode): void {
	selectedNode = node;
	focusedNodeId = node.id;
	emphasize(node.id, true);
	nodeDetailsTitle.textContent = `Block ${node.id}`;
	nodeDetailsText.textContent = node.label;
	openNodeSource.hidden = !node.source;
	nodeDetails.hidden = false;
	if (node.source) {
		vscode.postMessage({ type: 'highlightSource', graphId: graph.id, nodeId: node.id });
	}
	tracePath(graph, node.id);
	for (const candidate of viewportGroup.querySelectorAll<SVGGElement>('.node')) {
		candidate.tabIndex = candidate.dataset.nodeId === node.id ? 0 : -1;
	}
	const group = viewportGroup.querySelector<SVGGElement>(`[data-node-id="${cssEscape(node.id)}"]`);
	group?.focus();
}

function tracePath(graph: ControlFlowGraph, targetId: string): void {
	const entry = graph.entryNodeId ?? graph.nodes[0]?.id;
	const previous = new Map<string, string>();
	if (!entry) {
		return;
	}
	const pending = [entry];
	while (pending.length) {
		const current = pending.shift()!;
		if (current === targetId) {
			break;
		}
		for (const edge of graph.edges.filter(candidate => candidate.from === current)) {
			if (!previous.has(edge.to) && edge.to !== entry) {
				previous.set(edge.to, current);
				pending.push(edge.to);
			}
		}
	}
	const path = new Set<string>([targetId]);
	for (let current = targetId; previous.has(current); current = previous.get(current)!) {
		path.add(previous.get(current)!);
	}
	for (const element of viewportGroup.querySelectorAll<SVGGElement>('.node')) {
		element.classList.toggle('path-node', path.has(element.dataset.nodeId ?? ''));
	}
	for (const element of viewportGroup.querySelectorAll<SVGPathElement>('.edge')) {
		element.classList.toggle('path-edge', path.has(element.dataset.from ?? '')
			&& path.has(element.dataset.to ?? ''));
	}
}

function navigateGraph(event: KeyboardEvent, graph: ControlFlowGraph, node: ControlFlowNode): void {
	if (event.key === 'Enter' || event.key === ' ') {
		event.preventDefault();
		openSource(graph.id, node);
		return;
	}
	const forward = event.key === 'ArrowDown' || event.key === 'ArrowRight';
	const backward = event.key === 'ArrowUp' || event.key === 'ArrowLeft';
	const target = event.key === 'Home'
		? graph.entryNodeId
		: forward ? graph.edges.find(edge => edge.from === node.id)?.to
			: backward ? graph.edges.find(edge => edge.to === node.id)?.from
				: undefined;
	if (!target) {
		return;
	}
	event.preventDefault();
	const next = graph.nodes.find(candidate => candidate.id === target);
	if (next) {
		selectNode(graph, next);
	}
}

function emphasize(nodeId: string | undefined, persistent = false): void {
	for (const element of viewportGroup.querySelectorAll<SVGGElement>('.node')) {
		element.classList.toggle('incident', Boolean(nodeId) && element.dataset.nodeId === nodeId);
	}
	for (const element of viewportGroup.querySelectorAll<SVGPathElement>('.edge')) {
		element.classList.toggle('incident', Boolean(nodeId)
			&& (element.dataset.from === nodeId || element.dataset.to === nodeId));
	}
	if (!persistent && selectedNode) {
		emphasize(selectedNode.id, true);
	}
}

function applySearch(): void {
	const query = graphSearch.value.trim().toLocaleLowerCase();
	for (const element of viewportGroup.querySelectorAll<SVGGElement>('.node')) {
		const node = currentGraph?.nodes.find(candidate => candidate.id === element.dataset.nodeId);
		element.classList.toggle('search-match', Boolean(query) && Boolean(node?.label.toLocaleLowerCase().includes(query)));
		element.classList.toggle('search-muted', Boolean(query) && !node?.label.toLocaleLowerCase().includes(query));
	}
}

function exportSvg(): void {
	if (!currentGraph) {
		return;
	}
	const copy = svg.cloneNode(true) as SVGSVGElement;
	copy.setAttribute('viewBox', `0 0 ${canvas.clientWidth} ${canvas.clientHeight}`);
	vscode.postMessage({
		type: 'exportSvg',
		graphId: currentGraph.id,
		svg: new XMLSerializer().serializeToString(copy),
	});
}

function renderMinimap(): void {
	minimapContent.replaceChildren();
	const scale = Math.min(150 / graphBounds.width, 100 / graphBounds.height);
	const x = (160 - graphBounds.width * scale) / 2;
	const y = (110 - graphBounds.height * scale) / 2;
	const copy = viewportGroup.cloneNode(true) as SVGGElement;
	copy.removeAttribute('id');
	copy.setAttribute('transform', `translate(${x},${y}) scale(${scale})`);
	minimapContent.append(copy);
}

minimap.addEventListener('pointerdown', event => {
	if (!currentGraph) {
		return;
	}
	const bounds = minimap.getBoundingClientRect();
	const x = (event.clientX - bounds.left) / bounds.width;
	const y = (event.clientY - bounds.top) / bounds.height;
	viewport = {
		...viewport,
		x: canvas.clientWidth / 2 - graphBounds.width * viewport.scale * x,
		y: canvas.clientHeight / 2 - graphBounds.height * viewport.scale * y,
	};
	applyViewport();
});

function toggleLegend(event: MouseEvent): void {
	const button = event.currentTarget as HTMLButtonElement;
	const legend = requiredElement<HTMLElement>('edge-legend');
	legend.hidden = !legend.hidden;
	button.setAttribute('aria-expanded', String(!legend.hidden));
}

/**
 * A short accessible name. The visible label holds the whole basic block, which
 * is far too long to read out, so the name summarizes the node instead.
 */
function nodeDescription(node: ControlFlowNode): string {
	const parts = [`Block ${node.id}`];
	if (node.terminal) {
		parts.push(node.terminal);
	}
	if (node.source) {
		parts.push('press Enter to open source');
	}
	return parts.join(', ');
}

function openSource(graphId: string, node: ControlFlowNode): void {
	if (node.source) {
		vscode.postMessage({ type: 'openSource', graphId, nodeId: node.id });
	}
}

function fitToView(): void {
	const width = Math.max(1, canvas.clientWidth);
	const height = Math.max(1, canvas.clientHeight);
	const scale = clamp(Math.min((width - 48) / graphBounds.width, (height - 48) / graphBounds.height), 0.1, 2);
	viewport = {
		scale,
		x: (width - graphBounds.width * scale) / 2,
		y: (height - graphBounds.height * scale) / 2,
	};
	applyViewport();
}

function resetViewport(): void {
	viewport = { x: 24, y: 24, scale: 1 };
	applyViewport();
}

function zoomBy(factor: number, centerX = canvas.clientWidth / 2, centerY = canvas.clientHeight / 2): void {
	const scale = clamp(viewport.scale * factor, 0.1, 4);
	const ratio = scale / viewport.scale;
	viewport = {
		scale,
		x: centerX - (centerX - viewport.x) * ratio,
		y: centerY - (centerY - viewport.y) * ratio,
	};
	applyViewport();
}

function applyViewport(): void {
	viewportGroup.setAttribute('transform', `translate(${viewport.x},${viewport.y}) scale(${viewport.scale})`);
	const prior = vscode.getState();
	vscode.setState({ ...prior, viewport });
}

function finishDrag(event: PointerEvent): void {
	if (!pointer) {
		return;
	}
	const dragged = pointer.dragging;
	pointer = undefined;
	if (dragged) {
		suppressClick = true;
		canvas.releasePointerCapture(event.pointerId);
		canvas.classList.remove('dragging');
		applyViewport();
	}
}

function pointsPath(points: readonly { readonly x: number; readonly y: number }[]): string {
	return points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ');
}

function midpoint(points: readonly { readonly x: number; readonly y: number }[]): { x: number; y: number } {
	return points[Math.floor(points.length / 2)] ?? { x: 0, y: 0 };
}

function svgElement<K extends keyof SVGElementTagNameMap>(
	name: K,
	attributes: Readonly<Record<string, string>>,
): SVGElementTagNameMap[K] {
	const element = document.createElementNS(namespace, name);
	for (const [key, value] of Object.entries(attributes)) {
		element.setAttribute(key, value);
	}
	return element;
}

function requiredElement<T extends Element>(id: string): T {
	const element = document.getElementById(id);
	if (!element) {
		throw new Error(`Missing webview element: ${id}`);
	}
	return element as unknown as T;
}

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.max(minimum, Math.min(maximum, value));
}

function cssEscape(value: string): string {
	return value.replace(/[^a-zA-Z0-9_-]/g, character => `\\${character}`);
}
