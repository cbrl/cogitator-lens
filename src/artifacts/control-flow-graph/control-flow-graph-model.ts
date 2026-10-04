import type {
	ControlFlowEdge,
	ControlFlowEdgeKind,
	ControlFlowGraph,
	ControlFlowNode,
	ControlFlowSourceLocation,
	ControlFlowTerminal,
	RenderedArtifactMetric,
} from '../../types/index.js';
import { isRecord } from '../../common.js';

/**
 * The graph model shared by the extension host and the webview bundle.
 *
 * Compiler-derived graphs are validated here once, on the way out of a parser,
 * and validated again by the webview when a `render` message arrives.  Both
 * directions run the same code so the boundary cannot drift: a graph the host
 * considers well-formed is exactly a graph the webview will draw.
 *
 * This module must stay free of `node:` and `vscode` imports because it is
 * bundled into the browser entry point.
 */

/** Structural limits shared by graph validation and the webview message schema. */
export const graphLimits = {
	idLength: 4_096,
	labelLength: 100_000,
	position: 0x7fff_ffff,
	graphs: 10_000,
	nodesPerGraph: 100_000,
	edgesPerGraph: 250_000,
	referencedLinesPerNode: 100_000,
	diagnostics: 10_000,
	metrics: 1_000,
} as const;

/** Source URIs must stay on schemes the extension host can open locally. */
export const allowedSourceSchemes: ReadonlySet<string> = new Set(['file:', 'vscode-remote:']);

const edgeKinds = new Set<ControlFlowEdgeKind>([
	'unconditional',
	'true',
	'false',
	'fallthrough',
	'return',
	'exception',
]);
const terminalKinds = new Set<ControlFlowTerminal>(['return', 'throw', 'resume', 'unreachable']);

export interface GraphParseResult {
	readonly graphs: readonly ControlFlowGraph[];
	readonly diagnostics: readonly string[];
}

export type GraphValidation =
	{ readonly ok: true; readonly graph: ControlFlowGraph } | { readonly ok: false; readonly reason: string };

/**
 * Validates a single compiler-derived graph and returns a normalized copy.
 *
 * Optional members are dropped rather than carried as `undefined` so the value
 * can be compared and serialized without shape differences.
 */
export function validateControlFlowGraph(candidate: unknown): GraphValidation {
	if (!isRecord(candidate) || !allowedKeys(candidate, ['id', 'label', 'entryNodeId', 'nodes', 'edges'])) {
		return invalid('graph value is not an object with the expected members');
	}
	const id = boundedNonemptyString(candidate.id, graphLimits.idLength);
	const label = boundedNonemptyString(candidate.label, graphLimits.labelLength);
	if (!id || !label || !Array.isArray(candidate.nodes) || !Array.isArray(candidate.edges)) {
		return invalid('missing or invalid ID, label, nodes, or edges');
	}
	if (candidate.nodes.length > graphLimits.nodesPerGraph) {
		return invalid(`${JSON.stringify(label)} exceeds the ${graphLimits.nodesPerGraph} node limit`);
	}
	if (candidate.edges.length > graphLimits.edgesPerGraph) {
		return invalid(`${JSON.stringify(label)} exceeds the ${graphLimits.edgesPerGraph} edge limit`);
	}

	const nodes: ControlFlowNode[] = [];
	const nodeIds = new Set<string>();
	for (const rawNode of candidate.nodes) {
		const node = validateNode(rawNode);
		if (!node || nodeIds.has(node.id)) {
			return invalid(`invalid or duplicate node in ${JSON.stringify(label)}`);
		}
		nodeIds.add(node.id);
		nodes.push(node);
	}

	const entryNodeId =
		candidate.entryNodeId === undefined
			? undefined
			: boundedNonemptyString(candidate.entryNodeId, graphLimits.idLength);
	if (candidate.entryNodeId !== undefined && (!entryNodeId || !nodeIds.has(entryNodeId))) {
		return invalid(`entry node does not exist in ${JSON.stringify(label)}`);
	}

	const edges: ControlFlowEdge[] = [];
	for (const rawEdge of candidate.edges) {
		const edge = validateEdge(rawEdge, nodeIds);
		if (!edge) {
			return invalid(`edge has an invalid or missing endpoint in ${JSON.stringify(label)}`);
		}
		edges.push(edge);
	}

	return {
		ok: true,
		graph: {
			id,
			label,
			...(entryNodeId === undefined ? {} : { entryNodeId }),
			nodes,
			edges,
		},
	};
}

/**
 * Validates a parser's graphs before they reach the webview.  Invalid functions
 * are omitted individually with a diagnostic so a partially malformed compiler
 * dump stays useful.
 */
export function validateControlFlowGraphs(candidates: readonly unknown[]): GraphParseResult {
	const graphs: ControlFlowGraph[] = [];
	const diagnostics: string[] = [];
	const graphIds = new Set<string>();

	for (const [index, candidate] of candidates.slice(0, graphLimits.graphs).entries()) {
		const validated = validateControlFlowGraph(candidate);
		if (!validated.ok) {
			diagnostics.push(`Omitted control-flow graph ${index + 1}: ${validated.reason}.`);
			continue;
		}
		if (graphIds.has(validated.graph.id)) {
			diagnostics.push(
				`Omitted graph ${JSON.stringify(validated.graph.label)}: duplicate graph ID ${JSON.stringify(validated.graph.id)}.`,
			);
			continue;
		}
		graphIds.add(validated.graph.id);
		graphs.push(validated.graph);
	}
	if (candidates.length > graphLimits.graphs) {
		diagnostics.push(
			`Omitted ${candidates.length - graphLimits.graphs} graphs beyond the ${graphLimits.graphs} graph limit.`,
		);
	}

	graphs.sort(compareControlFlowGraphs);
	if (graphs.length === 0) {
		diagnostics.push('No valid control-flow graphs were found in the compiler output.');
	}
	return { graphs, diagnostics };
}

export function controlFlowGraphMetrics(
	graphs: readonly ControlFlowGraph[],
): Readonly<Record<string, RenderedArtifactMetric>> {
	let nodeCount = 0;
	let edgeCount = 0;
	let branchNodeCount = 0;
	let unreachableNodeCount = 0;
	let sourceMappedNodeCount = 0;
	for (const graph of graphs) {
		nodeCount += graph.nodes.length;
		edgeCount += graph.edges.length;
		sourceMappedNodeCount += graph.nodes.filter((node) => node.source).length;
		const outgoing = new Map<string, number>();
		for (const edge of graph.edges) {
			outgoing.set(edge.from, (outgoing.get(edge.from) ?? 0) + 1);
		}
		branchNodeCount += [...outgoing.values()].filter((count) => count > 1).length;
		if (graph.entryNodeId) {
			const reachable = reachableNodeIds(graph, graph.entryNodeId);
			unreachableNodeCount += graph.nodes.filter((node) => !reachable.has(node.id)).length;
		}
	}
	return Object.freeze({
		graphCount: graphs.length,
		nodeCount,
		edgeCount,
		branchNodeCount,
		unreachableNodeCount,
		sourceMappedNodeCount,
	});
}

/** Orders graphs by source position, then label, so refreshes stay deterministic. */
export function compareControlFlowGraphs(left: ControlFlowGraph, right: ControlFlowGraph): number {
	const leftSource = firstSource(left);
	const rightSource = firstSource(right);
	return (
		compareOptionalText(leftSource?.uri, rightSource?.uri) ||
		(leftSource?.line ?? graphLimits.position) - (rightSource?.line ?? graphLimits.position) ||
		(leftSource?.column ?? graphLimits.position) - (rightSource?.column ?? graphLimits.position) ||
		left.label.localeCompare(right.label, undefined, { numeric: true }) ||
		left.id.localeCompare(right.id, undefined, { numeric: true })
	);
}

export function allowedKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const allowed = new Set(keys);
	return Object.keys(value).every((key) => allowed.has(key));
}

export function boundedString(value: unknown, maximum: number): string | undefined {
	return typeof value === 'string' && value.length <= maximum ? value : undefined;
}

export function validPosition(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= graphLimits.position;
}

function validateNode(candidate: unknown): ControlFlowNode | undefined {
	if (
		!isRecord(candidate) ||
		!allowedKeys(candidate, ['id', 'label', 'source', 'referencedArtifactLines', 'terminal'])
	) {
		return undefined;
	}
	const id = boundedNonemptyString(candidate.id, graphLimits.idLength);
	const label = boundedString(candidate.label, graphLimits.labelLength);
	if (!id || label === undefined) {
		return undefined;
	}
	const source = optional(candidate.source, validateSourceLocation);
	const terminal = optional(candidate.terminal, (value) =>
		terminalKinds.has(value as ControlFlowTerminal) ? (value as ControlFlowTerminal) : undefined,
	);
	const referencedArtifactLines = optional(candidate.referencedArtifactLines, (value) =>
		Array.isArray(value) && value.length <= graphLimits.referencedLinesPerNode && value.every(validPosition)
			? (value as number[])
			: undefined,
	);
	if (source === invalidValue || terminal === invalidValue || referencedArtifactLines === invalidValue) {
		return undefined;
	}
	return {
		id,
		label,
		...(source === undefined ? {} : { source }),
		...(referencedArtifactLines === undefined ? {} : { referencedArtifactLines }),
		...(terminal === undefined ? {} : { terminal }),
	};
}

function validateEdge(candidate: unknown, nodeIds: ReadonlySet<string>): ControlFlowEdge | undefined {
	if (!isRecord(candidate) || !allowedKeys(candidate, ['from', 'to', 'kind', 'label'])) {
		return undefined;
	}
	const from = boundedNonemptyString(candidate.from, graphLimits.idLength);
	const to = boundedNonemptyString(candidate.to, graphLimits.idLength);
	const kind = edgeKinds.has(candidate.kind as ControlFlowEdgeKind)
		? (candidate.kind as ControlFlowEdgeKind)
		: undefined;
	const label = optional(candidate.label, (value) => boundedString(value, graphLimits.labelLength));
	if (!from || !to || !kind || !nodeIds.has(from) || !nodeIds.has(to) || label === invalidValue) {
		return undefined;
	}
	return { from, to, kind, ...(label === undefined ? {} : { label }) };
}

function validateSourceLocation(candidate: unknown): ControlFlowSourceLocation | undefined {
	if (
		!isRecord(candidate) ||
		!allowedKeys(candidate, ['uri', 'line', 'column', 'endLine', 'endColumn']) ||
		boundedString(candidate.uri, graphLimits.labelLength) === undefined ||
		!validPosition(candidate.line) ||
		!validPosition(candidate.column)
	) {
		return undefined;
	}
	try {
		if (!allowedSourceSchemes.has(new URL(candidate.uri as string).protocol)) {
			return undefined;
		}
	} catch {
		return undefined;
	}
	const endLine = optional(candidate.endLine, (value) => (validPosition(value) ? value : undefined));
	const endColumn = optional(candidate.endColumn, (value) => (validPosition(value) ? value : undefined));
	if (endLine === invalidValue || endColumn === invalidValue) {
		return undefined;
	}
	const resolvedEndLine = endLine ?? candidate.line;
	const resolvedEndColumn = endColumn ?? candidate.column;
	if (
		resolvedEndLine < candidate.line ||
		(resolvedEndLine === candidate.line && resolvedEndColumn < candidate.column)
	) {
		return undefined;
	}
	return {
		uri: candidate.uri as string,
		line: candidate.line,
		column: candidate.column,
		...(endLine === undefined ? {} : { endLine }),
		...(endColumn === undefined ? {} : { endColumn }),
	};
}

/**
 * Distinguishes "absent" from "present but malformed" for optional members: a
 * missing member yields `undefined`, a member that fails its check yields
 * `invalidValue` so the caller rejects the whole record.
 */
const invalidValue = Symbol('invalid');

function optional<T>(value: unknown, check: (value: unknown) => T | undefined): T | undefined | typeof invalidValue {
	if (value === undefined) {
		return undefined;
	}
	return check(value) ?? invalidValue;
}

function reachableNodeIds(graph: ControlFlowGraph, entry: string): Set<string> {
	const outgoing = new Map<string, string[]>();
	for (const edge of graph.edges) {
		const targets = outgoing.get(edge.from) ?? [];
		targets.push(edge.to);
		outgoing.set(edge.from, targets);
	}
	const reached = new Set<string>();
	const pending = [entry];
	while (pending.length > 0) {
		const current = pending.pop()!;
		if (reached.has(current)) {
			continue;
		}
		reached.add(current);
		pending.push(...(outgoing.get(current) ?? []));
	}
	return reached;
}

function firstSource(graph: ControlFlowGraph): ControlFlowSourceLocation | undefined {
	return graph.nodes.find((node) => node.source)?.source;
}

function compareOptionalText(left: string | undefined, right: string | undefined): number {
	if (left === right) {
		return 0;
	}
	if (left === undefined) {
		return 1;
	}
	if (right === undefined) {
		return -1;
	}
	return left.localeCompare(right);
}

function invalid(reason: string): GraphValidation {
	return { ok: false, reason };
}

function boundedNonemptyString(value: unknown, maximum: number): string | undefined {
	const text = boundedString(value, maximum);
	return text?.trim() ? text : undefined;
}
