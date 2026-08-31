import type { ControlFlowEdge, ControlFlowGraph } from '../../types/index.js';

/** Derived topology used by the graph canvas. Kept browser-safe for the webview. */
export interface GraphStructure {
	readonly reachable: ReadonlySet<string>;
	readonly backEdges: ReadonlySet<ControlFlowEdge>;
	readonly loopNodes: ReadonlySet<string>;
}

export function analyzeGraphStructure(graph: ControlFlowGraph): GraphStructure {
	const entry = graph.entryNodeId ?? graph.nodes[0]?.id;
	if (!entry) {
		return { reachable: new Set(), backEdges: new Set(), loopNodes: new Set() };
	}
	const outgoing = adjacency(graph.edges, 'from', 'to');
	const incoming = adjacency(graph.edges, 'to', 'from');
	const reachable = walk(entry, outgoing);
	const nodeIds = graph.nodes.map((node) => node.id).filter((id) => reachable.has(id));
	const dominators = new Map<string, Set<string>>();
	for (const id of nodeIds) {
		dominators.set(id, id === entry ? new Set([id]) : new Set(nodeIds));
	}
	let changed = true;
	while (changed) {
		changed = false;
		for (const id of nodeIds) {
			if (id === entry) {
				continue;
			}
			const predecessors = (incoming.get(id) ?? []).filter((predecessor) => reachable.has(predecessor));
			const next =
				predecessors.length === 0
					? new Set([id])
					: intersection(predecessors.map((predecessor) => dominators.get(predecessor) ?? new Set()));
			next.add(id);
			if (!sameSet(next, dominators.get(id)!)) {
				dominators.set(id, next);
				changed = true;
			}
		}
	}
	const backEdges = new Set<ControlFlowEdge>();
	const loopNodes = new Set<string>();
	for (const edge of graph.edges) {
		if (!reachable.has(edge.from) || !reachable.has(edge.to) || !dominators.get(edge.from)?.has(edge.to)) {
			continue;
		}
		backEdges.add(edge);
		for (const id of walk(edge.from, incoming, new Set([edge.to]))) {
			loopNodes.add(id);
		}
	}
	return { reachable, backEdges, loopNodes };
}

function adjacency(edges: readonly ControlFlowEdge[], key: 'from' | 'to', value: 'from' | 'to'): Map<string, string[]> {
	const result = new Map<string, string[]>();
	for (const edge of edges) {
		const values = result.get(edge[key]) ?? [];
		values.push(edge[value]);
		result.set(edge[key], values);
	}
	return result;
}

function walk(
	start: string,
	adjacencyMap: ReadonlyMap<string, readonly string[]>,
	initial = new Set<string>(),
): Set<string> {
	const visited = new Set(initial);
	const pending = [start];
	while (pending.length) {
		const current = pending.pop()!;
		if (visited.has(current)) {
			continue;
		}
		visited.add(current);
		for (const next of adjacencyMap.get(current) ?? []) {
			pending.push(next);
		}
	}
	return visited;
}

function intersection(sets: readonly ReadonlySet<string>[]): Set<string> {
	const [first, ...rest] = sets;
	return new Set([...(first ?? [])].filter((value) => rest.every((set) => set.has(value))));
}

function sameSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
	return left.size === right.size && [...left].every((value) => right.has(value));
}
