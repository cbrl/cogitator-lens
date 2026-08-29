import assert from 'node:assert/strict';
import test from 'node:test';
import { parseLlvmControlFlowGraphs } from '../src/artifacts/cfg/llvm-ir-cfg-parser.js';
import { parsePythonControlFlowGraphs } from '../src/artifacts/python-cfg.js';
import { validateControlFlowGraphs } from '../src/artifacts/control-flow-graph-model.js';
import {
	parseHostMessage,
	parseWebviewMessage,
} from '../src/webview/graph-protocol.js';
import type {
	ControlFlowGraph,
	ControlFlowNode,
	ControlFlowSourceLocation,
} from '../src/types/index.js';

const maximumPosition = 0x7fff_ffff;

test('CFG validation and host protocol constrain source URI schemes and ranges', () => {
	const supported = validateControlFlowGraphs([
		graph('file', { uri: 'file:///workspace/main.c', line: 0, column: 0 }),
		graph('remote', {
			uri: 'vscode-remote://ssh-remote+host/workspace/main.c',
			line: 1,
			column: 2,
			endLine: 2,
			endColumn: 3,
		}),
		graph('maximum', {
			uri: 'file:///workspace/maximum.c',
			line: maximumPosition,
			column: maximumPosition,
			endLine: maximumPosition,
			endColumn: maximumPosition,
		}),
	]);
	assert.equal(supported.graphs.length, 3);

	for (const [id, source] of [
		['http', { uri: 'https://example.invalid/main.c', line: 0, column: 0 }],
		['over-bound', { uri: 'file:///workspace/main.c', line: maximumPosition + 1, column: 0 }],
		['reverse-line', { uri: 'file:///workspace/main.c', line: 4, column: 0, endLine: 3, endColumn: 0 }],
		['reverse-column', { uri: 'file:///workspace/main.c', line: 4, column: 3, endLine: 4, endColumn: 2 }],
	] as const) {
		const result = validateControlFlowGraphs([graph(id, source)]);
		assert.equal(result.graphs.length, 0, `${id} source should be rejected`);
	}

	assert.ok(parseHostMessage(hostMessage([
		graph('file', { uri: 'file:///workspace/main.c', line: 0, column: 0 }),
		graph('remote', { uri: 'vscode-remote://ssh-remote+host/workspace/main.c', line: 0, column: 0 }),
	])));
	for (const source of [
		{ uri: 'http://example.invalid/main.c', line: 0, column: 0 },
		{ uri: 'file:///workspace/main.c', line: maximumPosition + 1, column: 0 },
		{ uri: 'file:///workspace/main.c', line: 3, column: 0, endLine: 2, endColumn: 0 },
		{ uri: 'file:///workspace/main.c', line: 3, column: 2, endLine: 3, endColumn: 1 },
	]) {
		assert.equal(parseHostMessage(hostMessage([graph('invalid', source)])), undefined);
	}
});

test('CFG validation rejects duplicate IDs, dangling endpoints, and invalid entries', () => {
	const base = graph('base');
	const duplicateNode = {
		...base,
		nodes: [
			{ id: 'entry', label: 'entry' },
			{ id: 'entry', label: 'duplicate' },
		],
	};
	const danglingEdge = {
		...base,
		edges: [{ from: 'entry', to: 'missing', kind: 'unconditional' }],
	};
	const invalidEntry = { ...base, entryNodeId: 'missing' };

	for (const candidate of [duplicateNode, danglingEdge, invalidEntry]) {
		assert.equal(validateControlFlowGraphs([candidate]).graphs.length, 0);
		assert.equal(parseHostMessage(hostMessage([candidate])), undefined);
	}
});

test('webview graph protocol rejects dangerous extras while preserving markup as data', () => {
	const markup = '<svg/onload=alert(1)>';
	const markedGraph: ControlFlowGraph = {
		...graph('markup'),
		nodes: [{ id: 'entry', label: markup }],
	};
	const parsed = parseHostMessage(hostMessage([markedGraph]));
	assert.ok(parsed);
	assert.equal(parsed.type, 'render');
	assert.equal(parsed.artifact.graphs[0].nodes[0].label, markup);

	const graphWithExtraNodeField = {
		...graph('extra-node'),
		nodes: [{ id: 'entry', label: 'entry', onclick: 'alert(1)' }],
	};
	const graphWithExtraGraphField = { ...graph('extra-graph'), script: 'alert(1)' };
	assert.equal(parseHostMessage(hostMessage([graphWithExtraNodeField])), undefined);
	assert.equal(parseHostMessage(hostMessage([graphWithExtraGraphField])), undefined);

	assert.equal(
		parseWebviewMessage({ type: 'openSource', graphId: 'g', nodeId: 'n', command: 'alert(1)' }),
		undefined,
	);
	assert.equal(parseWebviewMessage({ type: 'ready', html: '<script>bad</script>' }), undefined);
});

test('compiler parser graph IDs do not shift when an unrelated function is inserted', () => {
	const targetLlvm = [
		'define void @target() {',
		'entry:',
		'  ret void',
		'}',
	].join('\n');
	const unrelatedLlvm = [
		'define void @unrelated() {',
		'entry:',
		'  ret void',
		'}',
	].join('\n');
	const withoutPrefix = parseLlvmControlFlowGraphs(targetLlvm, '/workspace');
	const withPrefix = parseLlvmControlFlowGraphs(`${unrelatedLlvm}\n${targetLlvm}`, '/workspace');
	assert.equal(withoutPrefix.graphs.find(graph => graph.label === 'target')?.id, 'llvm:target');
	assert.equal(withPrefix.graphs.find(graph => graph.label === 'target')?.id, 'llvm:target');

	const pythonInstructions = [{
		offset: 0,
		opname: 'RETURN_VALUE',
		argrepr: '',
		startsLine: 1,
		line: 1,
		endLine: 1,
		column: 0,
		endColumn: 1,
		isJumpTarget: false,
		isJump: false,
		conditional: false,
		target: null,
		terminal: true,
		return: true,
	}];
	const pythonObject = (name: string) => ({
		name,
		filename: 'source.py',
		firstLine: 1,
		instructions: pythonInstructions,
		exceptions: [],
	});
	const pythonWithoutPrefix = parsePythonControlFlowGraphs(
		JSON.stringify({ codeObjects: [pythonObject('target')] }),
		'/workspace',
	);
	const pythonWithPrefix = parsePythonControlFlowGraphs(
		JSON.stringify({ codeObjects: [pythonObject('unrelated'), pythonObject('target')] }),
		'/workspace',
	);
	assert.equal(pythonWithoutPrefix.graphs.find(graph => graph.label === 'target')?.id, 'python:target');
	assert.equal(pythonWithPrefix.graphs.find(graph => graph.label === 'target')?.id, 'python:target');
});

function graph(
	id: string,
	source?: ControlFlowSourceLocation,
): ControlFlowGraph {
	const node: ControlFlowNode = {
		id: 'entry',
		label: 'entry',
		...(source === undefined ? {} : { source }),
	};
	return {
		id,
		label: id,
		entryNodeId: node.id,
		nodes: [node],
		edges: [],
	};
}

function hostMessage(graphs: readonly unknown[]): Record<string, unknown> {
	return {
		type: 'render',
		artifact: {
			graphs,
			metrics: {},
			diagnostics: [],
			stale: false,
		},
	};
}
