import assert from 'node:assert/strict';
import test from 'node:test';
import {
	controlFlowGraphMetrics,
	validateControlFlowGraphs,
} from '../../src/artifacts/control-flow-graph/control-flow-graph-model.js';
import { analyzeGraphStructure } from '../../src/artifacts/control-flow-graph/graph-structure.js';
import { parseHostMessage, parseWebviewMessage } from '../../src/webview/graph-protocol.js';
import type {
	ControlFlowEdge,
	ControlFlowGraph,
	ControlFlowNode,
	ControlFlowSourceLocation,
} from '../../src/types/index.js';

const maximumPosition = 0x7fff_ffff;

test('validation drops unusable graphs, keeps the rest, and reports each omission', () => {
	const valid = graph('valid', {
		source: { uri: 'file:///project/a.c', line: 1, column: 0 },
		nodes: [
			{ id: 'entry', label: 'entry', referencedArtifactLines: [0] },
			{ id: 'left', label: 'left', terminal: 'return', referencedArtifactLines: [1] },
			{ id: 'dead', label: 'dead', terminal: 'unreachable', referencedArtifactLines: [2] },
		],
		edges: [{ from: 'entry', to: 'left', kind: 'true' }],
	});
	const danglingEdge = graph('dangling-edge', {
		nodes: [{ id: 'entry', label: 'entry' }],
		edges: [{ from: 'entry', to: 'missing', kind: 'unconditional' }],
	});
	const duplicateNode = graph('duplicate-node', {
		nodes: [
			{ id: 'entry', label: 'entry' },
			{ id: 'entry', label: 'duplicate' },
		],
		edges: [],
	});
	const unknownEntry = {
		...graph('unknown-entry', { nodes: [{ id: 'entry', label: 'entry' }], edges: [] }),
		entryNodeId: 'missing',
	};

	const result = validateControlFlowGraphs([danglingEdge, valid, duplicateNode, unknownEntry]);
	assert.deepEqual(
		result.graphs.map((item) => item.id),
		['valid'],
	);
	// Every dropped graph is accounted for by exactly one diagnostic.
	assert.equal(result.diagnostics.length, 3);
	assert.deepEqual(controlFlowGraphMetrics(result.graphs), {
		graphCount: 1,
		nodeCount: 3,
		edgeCount: 1,
		branchNodeCount: 0,
		unreachableNodeCount: 1,
		sourceMappedNodeCount: 1,
	});
});

test('validation orders graphs by source location and counts branch nodes', () => {
	const later = graph('later', {
		source: { uri: 'file:///project/b.c', line: 1, column: 0 },
		nodes: [
			{ id: 'entry', label: 'entry', referencedArtifactLines: [0] },
			{ id: 'exit', label: 'exit', terminal: 'return' },
		],
		edges: [
			{ from: 'entry', to: 'exit', kind: 'true' },
			{ from: 'entry', to: 'exit', kind: 'false' },
		],
	});
	const earlier = graph('earlier', {
		source: { uri: 'file:///project/a.c', line: 0, column: 0 },
		nodes: [{ id: 'entry', label: 'entry' }],
		edges: [],
	});

	const result = validateControlFlowGraphs([later, earlier]);
	assert.deepEqual(
		result.graphs.map((item) => item.id),
		['earlier', 'later'],
	);
	assert.deepEqual(controlFlowGraphMetrics(result.graphs), {
		graphCount: 2,
		nodeCount: 3,
		edgeCount: 2,
		branchNodeCount: 1,
		unreachableNodeCount: 0,
		sourceMappedNodeCount: 2,
	});
});

test('validation constrains source URI schemes and position ranges', () => {
	const accepted = validateControlFlowGraphs([
		sourceGraph('file', { uri: 'file:///workspace/main.c', line: 0, column: 0 }),
		sourceGraph('remote', {
			uri: 'vscode-remote://ssh-remote+host/workspace/main.c',
			line: 1,
			column: 2,
			endLine: 2,
			endColumn: 3,
		}),
		sourceGraph('maximum', {
			uri: 'file:///workspace/maximum.c',
			line: maximumPosition,
			column: maximumPosition,
			endLine: maximumPosition,
			endColumn: maximumPosition,
		}),
	]);
	assert.equal(accepted.graphs.length, 3);

	for (const [id, source] of [
		['http', { uri: 'https://example.invalid/main.c', line: 0, column: 0 }],
		['over-bound', { uri: 'file:///workspace/main.c', line: maximumPosition + 1, column: 0 }],
		['reverse-line', { uri: 'file:///workspace/main.c', line: 4, column: 0, endLine: 3, endColumn: 0 }],
		['reverse-column', { uri: 'file:///workspace/main.c', line: 4, column: 3, endLine: 4, endColumn: 2 }],
	] as const) {
		assert.equal(validateControlFlowGraphs([sourceGraph(id, source)]).graphs.length, 0, `${id} must be rejected`);
	}
});

test('graph structure identifies natural loops and unreachable nodes', () => {
	const structure = analyzeGraphStructure({
		id: 'structure',
		label: 'structure',
		entryNodeId: 'entry',
		nodes: [
			{ id: 'entry', label: 'entry' },
			{ id: 'loop', label: 'loop' },
			{ id: 'body', label: 'body' },
			{ id: 'exit', label: 'exit' },
			{ id: 'dead', label: 'dead' },
		],
		edges: [
			{ from: 'entry', to: 'loop', kind: 'unconditional' },
			{ from: 'loop', to: 'body', kind: 'true' },
			{ from: 'loop', to: 'exit', kind: 'false' },
			{ from: 'body', to: 'loop', kind: 'unconditional' },
		],
	});
	assert.deepEqual([...structure.reachable].sort(), ['body', 'entry', 'exit', 'loop']);
	assert.deepEqual([...structure.loopNodes].sort(), ['body', 'loop']);
	assert.equal(structure.backEdges.size, 1);
});

test('webview protocol accepts the exact message schemas and nothing more', () => {
	assert.deepEqual(parseWebviewMessage({ type: 'ready' }), { type: 'ready' });
	assert.deepEqual(parseWebviewMessage({ type: 'refresh' }), { type: 'refresh' });
	assert.deepEqual(parseWebviewMessage({ type: 'exportDot', graphId: 'g' }), { type: 'exportDot', graphId: 'g' });
	for (const type of ['openSource', 'highlightSource'] as const) {
		assert.deepEqual(parseWebviewMessage({ type, graphId: 'g', nodeId: 'entry' }), {
			type,
			graphId: 'g',
			nodeId: 'entry',
		});
	}
	assert.equal(parseWebviewMessage({ type: 'ready', extra: true }), undefined);
	assert.equal(parseWebviewMessage({ type: 'openSource', graphId: '', nodeId: 'entry' }), undefined);
	assert.equal(parseWebviewMessage({ type: 'unknown' }), undefined);
	assert.equal(parseWebviewMessage({ type: 'exportSvg', graphId: 'g', svg: 'x'.repeat(10_000_001) }), undefined);

	assert.deepEqual(parseHostMessage({ type: 'theme', theme: 'high-contrast' }), {
		type: 'theme',
		theme: 'high-contrast',
	});
	assert.equal(parseHostMessage({ type: 'theme', theme: 'blue' }), undefined);
});

test('the host protocol rejects injected fields but carries markup through as data', () => {
	const markup = '<svg/onload=alert(1)>';
	const marked = { ...sourceGraph('markup'), nodes: [{ id: 'entry', label: markup }] };
	const parsed = parseHostMessage(renderMessage([marked]));
	assert.ok(parsed);
	assert.equal(parsed.type, 'render');
	assert.equal(parsed.artifact.graphs[0].nodes[0].label, markup);
	assert.equal(parseHostMessage({ ...renderMessage([marked]), injected: '<script>' }), undefined);
	assert.equal(
		parseHostMessage(
			renderMessage([{ ...sourceGraph('extra-node'), nodes: [{ id: 'entry', label: 'e', onclick: 'x' }] }]),
		),
		undefined,
	);
	assert.equal(parseHostMessage(renderMessage([{ ...sourceGraph('extra-graph'), script: 'alert(1)' }])), undefined);

	// The protocol runs the same validator as the model, but rejects the whole
	// message instead of omitting the offending graph.
	assert.equal(
		parseHostMessage(
			renderMessage([sourceGraph('invalid', { uri: 'http://example.invalid/main.c', line: 0, column: 0 })]),
		),
		undefined,
	);
});

function graph(
	id: string,
	options: {
		readonly source?: ControlFlowSourceLocation;
		readonly nodes: readonly ControlFlowNode[];
		readonly edges: readonly ControlFlowEdge[];
	},
): ControlFlowGraph {
	const nodes = options.nodes.map((node, index) =>
		index === 0 && options.source ? { ...node, source: options.source } : node,
	);
	return { id, label: id, entryNodeId: String(nodes[0].id), nodes, edges: options.edges };
}

function sourceGraph(id: string, source?: ControlFlowSourceLocation): ControlFlowGraph {
	return graph(id, { ...(source ? { source } : {}), nodes: [{ id: 'entry', label: 'entry' }], edges: [] });
}

function renderMessage(graphs: readonly unknown[]): Record<string, unknown> {
	return {
		type: 'render',
		artifact: { graphs, metrics: {}, diagnostics: [], stale: false },
	};
}
