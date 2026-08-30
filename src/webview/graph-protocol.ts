import type {
	ControlFlowGraph,
	RenderedArtifactMetric,
} from '../types/index.js';
import {
	allowedKeys,
	boundedString,
	graphLimits,
	isRecord,
	validateControlFlowGraph,
} from '../artifacts/control-flow-graph/control-flow-graph-model.js';

/**
 * The discriminated message protocol between the graph panel and its webview.
 *
 * Graph contents are checked by the shared model validator, so the host and the
 * webview agree on what a well-formed graph is. This module only validates the
 * message envelope around them.
 */

export interface SerializedGraphArtifact {
	readonly graphs: readonly ControlFlowGraph[];
	readonly metrics: Readonly<Record<string, RenderedArtifactMetric>>;
	readonly diagnostics: readonly string[];
	readonly stale: boolean;
	readonly failure?: string;
}

export type GraphTheme = 'light' | 'dark' | 'high-contrast';

export type HostMessage =
	| {
		readonly type: 'render';
		readonly artifact: SerializedGraphArtifact;
		readonly selectedGraphId?: string;
	}
	| { readonly type: 'theme'; readonly theme: GraphTheme };

export type WebviewMessage =
	| { readonly type: 'ready' }
	| { readonly type: 'openSource'; readonly graphId: string; readonly nodeId: string }
	| { readonly type: 'highlightSource'; readonly graphId: string; readonly nodeId: string }
	| { readonly type: 'selectionChanged'; readonly graphId: string }
	| { readonly type: 'refresh' }
	| { readonly type: 'exportDot'; readonly graphId: string }
	| { readonly type: 'exportSvg'; readonly graphId: string; readonly svg: string };

/**
 * Validates a message received in the browser before rendering compiler text.
 *
 * The host only ever posts graphs it has already validated, so a malformed
 * graph means the message did not come from a healthy host: the whole message
 * is rejected rather than partially rendered.
 */
export function parseHostMessage(value: unknown): HostMessage | undefined {
	if (!isRecord(value) || typeof value.type !== 'string') {
		return undefined;
	}
	if (value.type === 'theme') {
		return exactKeys(value, ['type', 'theme']) && isGraphTheme(value.theme)
			? { type: 'theme', theme: value.theme }
			: undefined;
	}
	if (value.type !== 'render'
		|| !allowedKeys(value, ['type', 'artifact', 'selectedGraphId'])
		|| (value.selectedGraphId !== undefined && !validId(value.selectedGraphId))) {
		return undefined;
	}
	const artifact = parseSerializedGraphArtifact(value.artifact);
	if (!artifact) {
		return undefined;
	}
	return {
		type: 'render',
		artifact,
		...(value.selectedGraphId === undefined ? {} : { selectedGraphId: value.selectedGraphId as string }),
	};
}

/** Strictly validates the complete webview-to-extension message shape. */
export function parseWebviewMessage(value: unknown): WebviewMessage | undefined {
	if (!isRecord(value) || typeof value.type !== 'string') {
		return undefined;
	}
	switch (value.type) {
		case 'ready':
			return exactKeys(value, ['type']) ? { type: 'ready' } : undefined;
		case 'openSource':
			return exactKeys(value, ['type', 'graphId', 'nodeId'])
				&& validId(value.graphId)
				&& validId(value.nodeId)
					? { type: 'openSource', graphId: value.graphId, nodeId: value.nodeId }
					: undefined;
		case 'highlightSource':
			return exactKeys(value, ['type', 'graphId', 'nodeId'])
				&& validId(value.graphId)
				&& validId(value.nodeId)
				? { type: 'highlightSource', graphId: value.graphId, nodeId: value.nodeId }
				: undefined;
		case 'selectionChanged':
			return exactKeys(value, ['type', 'graphId']) && validId(value.graphId)
				? { type: 'selectionChanged', graphId: value.graphId }
				: undefined;
		case 'refresh':
			return exactKeys(value, ['type']) ? { type: 'refresh' } : undefined;
		case 'exportDot':
			return exactKeys(value, ['type', 'graphId']) && validId(value.graphId)
				? { type: 'exportDot', graphId: value.graphId }
				: undefined;
		case 'exportSvg':
			return exactKeys(value, ['type', 'graphId', 'svg'])
				&& validId(value.graphId)
				&& typeof value.svg === 'string'
				&& value.svg.length <= 10_000_000
				? { type: 'exportSvg', graphId: value.graphId, svg: value.svg }
				: undefined;
		default:
			return undefined;
	}
}

function parseSerializedGraphArtifact(value: unknown): SerializedGraphArtifact | undefined {
	if (!isRecord(value)
		|| !allowedKeys(value, ['graphs', 'metrics', 'diagnostics', 'stale', 'failure'])
		|| typeof value.stale !== 'boolean'
		|| !isRecord(value.metrics)
		|| !Array.isArray(value.graphs)
		|| value.graphs.length > graphLimits.graphs
		|| !Array.isArray(value.diagnostics)
		|| value.diagnostics.length > graphLimits.diagnostics
		|| !value.diagnostics.every(item => boundedString(item, graphLimits.labelLength) !== undefined)
		|| (value.failure !== undefined && boundedString(value.failure, graphLimits.labelLength) === undefined)
		|| !validMetrics(value.metrics)) {
		return undefined;
	}

	const graphs: ControlFlowGraph[] = [];
	const graphIds = new Set<string>();
	for (const candidate of value.graphs) {
		const validated = validateControlFlowGraph(candidate);
		if (!validated.ok || graphIds.has(validated.graph.id)) {
			return undefined;
		}
		graphIds.add(validated.graph.id);
		graphs.push(validated.graph);
	}
	return {
		graphs,
		metrics: value.metrics as Record<string, RenderedArtifactMetric>,
		diagnostics: value.diagnostics as string[],
		stale: value.stale,
		...(value.failure === undefined ? {} : { failure: value.failure as string }),
	};
}

function validMetrics(metrics: Record<string, unknown>): boolean {
	const entries = Object.entries(metrics);
	return entries.length <= graphLimits.metrics
		&& entries.every(([name, metric]) =>
			name.length <= graphLimits.idLength
			&& (boundedString(metric, graphLimits.labelLength) !== undefined
				|| typeof metric === 'number' && Number.isFinite(metric)
				|| typeof metric === 'boolean'));
}

function validId(value: unknown): value is string {
	return typeof value === 'string' && value.trim().length > 0 && value.length <= graphLimits.idLength;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	return Object.keys(value).length === keys.length && allowedKeys(value, keys);
}

function isGraphTheme(value: unknown): value is GraphTheme {
	return value === 'light' || value === 'dark' || value === 'high-contrast';
}
