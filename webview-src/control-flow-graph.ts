import { graphlib, layout } from '@dagrejs/dagre';
import type {
	ControlFlowEdge,
	ControlFlowGraph,
	ControlFlowNode,
} from '../src/types/index.js';
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
const selector = requiredElement<HTMLSelectElement>('function-selector');
const canvas = requiredElement<HTMLDivElement>('graph-canvas');
const diagnostics = requiredElement<HTMLDivElement>('diagnostics');
const staleBadge = requiredElement<HTMLSpanElement>('stale-badge');
const emptyState = requiredElement<HTMLDivElement>('empty-state');
const svg = requiredElement<SVGSVGElement>('graph-svg');
const viewportGroup = requiredElement<SVGGElement>('graph-viewport');
let artifact: SerializedGraphArtifact | undefined;
let viewport: Viewport = vscode.getState()?.viewport ?? { x: 24, y: 24, scale: 1 };
let graphBounds = { width: 1, height: 1 };
let pointer: { x: number; y: number; origin: Viewport; dragging: boolean } | undefined;
/** Set when a drag ends, so the click it synthesizes does not open a source. */
let suppressClick = false;
const dragThreshold = 4;

selector.addEventListener('change', () => selectGraph(selector.value, true, true));
requiredElement<HTMLButtonElement>('fit').addEventListener('click', fitToView);
requiredElement<HTMLButtonElement>('zoom-in').addEventListener('click', () => zoomBy(1.2));
requiredElement<HTMLButtonElement>('zoom-out').addEventListener('click', () => zoomBy(1 / 1.2));
requiredElement<HTMLButtonElement>('reset').addEventListener('click', resetViewport);

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
	selector.replaceChildren(...artifact.graphs.map(graph => {
		const option = document.createElement('option');
		option.value = graph.id;
		option.textContent = graph.label;
		return option;
	}));
	const selected = artifact.graphs.some(graph => graph.id === previous)
		? previous
		: artifact.graphs[0]?.id;
	selector.disabled = artifact.graphs.length < 2;
	if (!selected) {
		viewportGroup.replaceChildren();
		canvas.dataset.empty = 'true';
		emptyState.hidden = false;
		return;
	}
	selector.value = selected;
	selectGraph(selected, false, priorState?.selectedGraphId !== selected);
}

function selectGraph(graphId: string, notifyHost: boolean, fit: boolean): void {
	const graph = artifact?.graphs.find(candidate => candidate.id === graphId);
	if (!graph) {
		return;
	}
	canvas.dataset.empty = 'false';
	emptyState.hidden = true;
	canvas.dataset.laidOutGraphId = graph.id;
	viewportGroup.replaceChildren();
	drawGraph(graph);
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
	const layoutGraph = new graphlib.Graph({ multigraph: true })
		.setGraph({ rankdir: 'TB', ranksep: 54, nodesep: 36, edgesep: 18, marginx: 20, marginy: 20 })
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
			class: `edge edge-${edge.kind}`,
			d: pointsPath(positioned.points ?? []),
			'marker-end': 'url(#arrowhead)',
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
			class: `node${node.terminal ? ` terminal terminal-${node.terminal}` : ''}${node.source ? ' source-linked' : ''}`,
			transform: `translate(${position.x},${position.y})`,
			role: node.source ? 'button' : 'group',
			tabindex: node.source ? '0' : '-1',
			'aria-label': nodeDescription(node),
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
		if (node.source) {
			const title = svgElement('title', {});
			title.textContent = 'Click to open the mapped source line';
			group.append(title);
			group.addEventListener('click', () => {
				if (suppressClick) {
					return;
				}
				openSource(graph.id, node);
			});
			group.addEventListener('keydown', event => {
				if (event.key === 'Enter' || event.key === ' ') {
					event.preventDefault();
					openSource(graph.id, node);
				}
			});
		}
		nodeLayer.append(group);
	}
	viewportGroup.append(nodeLayer);
}

function renderDiagnostics(value: SerializedGraphArtifact): void {
	const messages = [
		...(value.failure ? [`Refresh failed: ${value.failure}`] : []),
		...value.diagnostics,
	];
	diagnostics.replaceChildren(...messages.map(message => {
		const row = document.createElement('div');
		row.className = value.failure && messages[0] === message ? 'diagnostic error' : 'diagnostic';
		row.textContent = message;
		return row;
	}));
	diagnostics.hidden = messages.length === 0;
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
