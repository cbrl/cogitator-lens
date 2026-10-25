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
	const { reachable, dominates } = dominators(entry, outgoing, incoming);
	const backEdges = new Set<ControlFlowEdge>();
	const loopSources = new Map<string, string[]>();
	for (const edge of graph.edges) {
		if (!reachable.has(edge.from) || !dominates(edge.to, edge.from)) {
			continue;
		}
		backEdges.add(edge);
		const sources = loopSources.get(edge.to) ?? [];
		sources.push(edge.from);
		loopSources.set(edge.to, sources);
	}
	// Back edges to the same header share one natural loop, so each header is walked once. An
	// unreachable predecessor is in no loop, though it is drawn with one.
	const loopNodes = new Set<string>();
	for (const [header, sources] of loopSources) {
		for (const id of walk(sources, incoming, new Set([header]))) {
			if (reachable.has(id)) {
				loopNodes.add(id);
			}
		}
	}
	return { reachable, backEdges, loopNodes };
}

/**
 * Finds the nodes reachable from the entry and their dominator tree, with the iterative algorithm
 * of Cooper, Harvey, and Kennedy's "A Simple, Fast Dominance Algorithm". Numbering the tree's
 * nodes on entry and exit then answers each dominance query in constant time.
 */
function dominators(
	entry: string,
	outgoing: ReadonlyMap<string, readonly string[]>,
	incoming: ReadonlyMap<string, readonly string[]>,
): { reachable: ReadonlySet<string>; dominates: (dominator: string, node: string) => boolean } {
	const order = postorder(entry, outgoing);
	const position = new Map(order.map((id, index) => [id, index]));
	const root = order.length - 1;
	const immediate = new Array<number>(order.length).fill(-1);
	immediate[root] = root;
	const commonDominator = (left: number, right: number): number => {
		while (left !== right) {
			while (left < right) {
				left = immediate[left];
			}
			while (right < left) {
				right = immediate[right];
			}
		}
		return left;
	};
	let changed = true;
	while (changed) {
		changed = false;
		for (let node = root - 1; node >= 0; node--) {
			let next = -1;
			for (const predecessor of incoming.get(order[node]) ?? []) {
				const index = position.get(predecessor);
				if (index !== undefined && immediate[index] !== -1) {
					next = next === -1 ? index : commonDominator(index, next);
				}
			}
			if (immediate[node] !== next) {
				immediate[node] = next;
				changed = true;
			}
		}
	}

	const children = order.map((): number[] => []);
	for (let node = 0; node < root; node++) {
		children[immediate[node]].push(node);
	}
	const enter = new Array<number>(order.length);
	const exit = new Array<number>(order.length);
	let clock = 0;
	const pending: { node: number; leaving: boolean }[] = [{ node: root, leaving: false }];
	while (pending.length) {
		const { node, leaving } = pending.pop()!;
		if (leaving) {
			exit[node] = clock++;
			continue;
		}
		enter[node] = clock++;
		pending.push({ node, leaving: true });
		for (const child of children[node]) {
			pending.push({ node: child, leaving: false });
		}
	}
	return {
		reachable: new Set(order),
		dominates: (dominator, node) => {
			const outer = position.get(dominator);
			const inner = position.get(node);
			return (
				outer !== undefined && inner !== undefined && enter[outer] <= enter[inner] && exit[inner] <= exit[outer]
			);
		},
	};
}

/** The nodes reachable from the entry, each after everything it leads to first; the entry is last. */
function postorder(entry: string, outgoing: ReadonlyMap<string, readonly string[]>): string[] {
	const order: string[] = [];
	const visited = new Set([entry]);
	const pending = [{ id: entry, next: 0 }];
	while (pending.length) {
		const top = pending[pending.length - 1];
		const successors = outgoing.get(top.id) ?? [];
		if (top.next < successors.length) {
			const successor = successors[top.next++];
			if (!visited.has(successor)) {
				visited.add(successor);
				pending.push({ id: successor, next: 0 });
			}
		} else {
			order.push(top.id);
			pending.pop();
		}
	}
	return order;
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
	starts: readonly string[],
	adjacencyMap: ReadonlyMap<string, readonly string[]>,
	initial = new Set<string>(),
): Set<string> {
	const visited = new Set(initial);
	const pending = [...starts];
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
