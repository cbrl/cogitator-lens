import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import {
	gccControlFlowGraphOutput,
	llvmIrOutput,
	rustLlvmIrOutput,
	rustMirOutput,
} from '../src/artifacts/compiler-output-producer.js';
import { renderControlFlowGraphArtifact } from '../src/artifacts/control-flow-graph-renderer.js';
import {
	controlFlowGraphMetrics,
	validateControlFlowGraphs,
} from '../src/artifacts/control-flow-graph-model.js';
import { parseGccControlFlowGraphs } from '../src/artifacts/gcc-cfg-parser.js';
import { parseLlvmControlFlowGraphs } from '../src/artifacts/cfg/llvm-ir-cfg-parser.js';
import { parsePythonControlFlowGraphs } from '../src/artifacts/python-cfg.js';
import {
	pythonCfgHelper,
	pythonControlFlowGraphProducer,
} from '../src/artifacts/python-cfg.js';
import { parseRustMirControlFlowGraphs } from '../src/artifacts/rust-mir-cfg-parser.js';
import { renderedArtifact } from '../src/artifacts/rendered-artifact.js';
import {
	getArtifactOutputChoices,
	resolveArtifactAvailability,
	resolveArtifactOutput,
	toolchainDefinitions,
} from '../src/toolchains/toolchain-map.js';
import { ToolchainBackend } from '../src/toolchains/toolchain-backend.js';
import { defaultArtifactOptions } from '../src/types/index.js';
import {
	parseHostMessage,
	parseWebviewMessage,
} from '../src/webview/graph-protocol.js';
import type {
	ArtifactKind,
	ControlFlowEdge,
	ControlFlowGraph,
	ControlFlowNode,
	ControlFlowSourceLocation,
	RawArtifact,
	ToolchainKind,
	ToolchainProfile,
} from '../src/types/index.js';

test('control-flow graph validation omits invalid functions but retains valid ones', () => {
	const valid = graph('valid', 'Valid', {
		source: { uri: 'file:///project/a.c', line: 1, column: 0 },
		nodes: [
			{ id: 'entry', label: 'entry', referencedArtifactLines: [0] },
			{ id: 'left', label: 'left', terminal: 'return', referencedArtifactLines: [1] },
			{ id: 'dead', label: 'dead', terminal: 'unreachable', referencedArtifactLines: [2] },
		],
		edges: [{ from: 'entry', to: 'left', kind: 'true' }],
	});
	const invalidEdge = graph('invalid-edge', 'Invalid edge', {
		nodes: [{ id: 'entry', label: 'entry' }],
		edges: [{ from: 'entry', to: 'missing', kind: 'unconditional' }],
	});
	const invalidSource = graph('invalid-source', 'Invalid source', {
		nodes: [{
			id: 'entry',
			label: 'entry',
			source: { uri: 'https://example.invalid/source.c', line: 0, column: 0 },
		}],
		edges: [],
	});

	const result = validateControlFlowGraphs([invalidEdge, valid, invalidSource]);
	assert.deepEqual(result.graphs.map(item => item.id), ['valid']);
	assert.equal(result.diagnostics.length, 2);
	assert.ok(result.diagnostics.every(message => /Omitted control-flow graph/u.test(message)));

	const metrics = controlFlowGraphMetrics(result.graphs);
	assert.deepEqual(metrics, {
		graphCount: 1,
		nodeCount: 3,
		edgeCount: 1,
		branchNodeCount: 0,
		unreachableNodeCount: 1,
		sourceMappedNodeCount: 1,
	});
});

test('control-flow graph validation sorts by source location deterministically and computes branches', () => {
	const later = graph('later', 'later', {
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
	const earlier = graph('earlier', 'earlier', {
		source: { uri: 'file:///project/a.c', line: 0, column: 0 },
		nodes: [{ id: 'entry', label: 'entry' }],
		edges: [],
	});

	const result = validateControlFlowGraphs([later, earlier]);
	assert.deepEqual(result.graphs.map(item => item.id), ['earlier', 'later']);
	assert.deepEqual(controlFlowGraphMetrics(result.graphs), {
		graphCount: 2,
		nodeCount: 3,
		edgeCount: 2,
		branchNodeCount: 1,
		unreachableNodeCount: 0,
		sourceMappedNodeCount: 2,
	});
});

test('LLVM CFG parser maps branches, quoted labels, terminal blocks, and debug metadata', () => {
	const text = [
		'define i32 @choose(i1 %condition) {',
		'entry:',
		'  br i1 %condition, label %"then.block", label %exit, !dbg !1',
		'"then.block":',
		'  ret i32 1, !dbg !2',
		'exit:',
		'  unreachable',
		'}',
		'!1 = !DILocation(line: 2, column: 3, scope: !3)',
		'!2 = !DILocation(line: 4, column: 3, scope: !3)',
		'!3 = distinct !DISubprogram(name: "choose", file: !4, scope: !4, line: 1)',
		'!4 = !DIFile(filename: "main.c", directory: "/project")',
	].join('\n');

	const result = parseLlvmControlFlowGraphs(text, '/workspace');
	assert.deepEqual(result.diagnostics, []);
	assert.equal(result.graphs.length, 1);
	const [parsed] = result.graphs;
	assert.equal(parsed.id, 'llvm:choose');
	assert.deepEqual(parsed.nodes.map(node => node.id), ['entry', 'then.block', 'exit']);
	// A node shows the IR it stands for, not just the block's name.
	assert.deepEqual(parsed.nodes.map(node => node.label), [
		'entry:\nbr i1 %condition, label %"then.block", label %exit, !dbg !1',
		'then.block:\nret i32 1, !dbg !2',
		'exit:\nunreachable',
	]);
	assert.deepEqual(parsed.edges, [
		{ from: 'entry', to: 'then.block', kind: 'true' },
		{ from: 'entry', to: 'exit', kind: 'false' },
	]);
	assert.equal(parsed.nodes[1].terminal, 'return');
	assert.equal(parsed.nodes[2].terminal, 'unreachable');
	assert.equal(parsed.nodes[0].source?.uri, 'file:///project/main.c');
	assert.equal(parsed.nodes[0].source?.line, 1);
	assert.equal(parsed.nodes[0].source?.column, 2);
	assert.deepEqual(parsed.nodes[0].referencedArtifactLines, [1, 2]);
});

test('LLVM CFG parser omits a malformed partial function without suppressing later functions', () => {
	const result = parseLlvmControlFlowGraphs([
		'define void @partial() {',
		'entry:',
		'  br label %missing',
		'define void @valid() {',
		'entry:',
		'  ret void',
		'}',
	].join('\n'), '/project');

	assert.equal(result.graphs.length, 1);
	assert.equal(result.graphs[0].id, 'llvm:valid');
	assert.equal(result.graphs[0].nodes[0].id, 'entry');
	assert.deepEqual(result.graphs[0].edges, []);
	assert.ok(result.diagnostics.some(message => /no closing brace/u.test(message)));
	assert.ok(result.diagnostics.some(message => /missing block/u.test(message)));
	assert.ok(result.diagnostics.some(message => /was omitted/u.test(message)));
});

test('LLVM CFG parser rejects duplicate or over-specified branches and models EH unwind-to-caller', () => {
	const result = parseLlvmControlFlowGraphs([
		'define void @duplicate() {',
		'entry:',
		'  br label %entry',
		'entry:',
		'  ret void',
		'}',
		'define void @bad_branch(i1 %condition) {',
		'entry:',
		'  br i1 %condition, label %left, label %right, label %extra',
		'left:',
		'  ret void',
		'right:',
		'  ret void',
		'extra:',
		'  ret void',
		'}',
		'define void @exception_path() {',
		'entry:',
		'  %pad = catchswitch within none [label %handler] unwind to caller',
		'handler:',
		'  cleanupret from %pad unwind to caller',
		'}',
	].join('\n'), '/project');

	assert.deepEqual(result.graphs.map(graph => graph.id), ['llvm:exception_path']);
	assert.deepEqual(result.graphs[0].edges, [
		{ from: 'entry', to: 'handler', kind: 'exception' },
	]);
	assert.equal(result.graphs[0].nodes[0].terminal, 'resume');
	assert.equal(result.graphs[0].nodes[1].terminal, 'resume');
	assert.ok(result.diagnostics.some(message => /duplicate basic-block identity/u.test(message)));
	assert.ok(result.diagnostics.some(message => /3 label targets/u.test(message)));
});

test('LLVM CFG parser covers switch, indirect, invoke, callbr, resume, and return terminators', () => {
	const result = parseLlvmControlFlowGraphs([
		'declare i32 @may_throw()',
		'define void @terminators(i32 %value, ptr %target) {',
		'entry:',
		'  switch i32 %value, label %indirect [',
		'    i32 0, label %invoke.block',
		'    i32 1, label %"call block"',
		'  ]',
		'indirect:',
		'  indirectbr ptr %target, [label %invoke.block, label %"call block"]',
		'invoke.block:',
		'  %invoked = invoke i32 @may_throw()',
		'      to label %"call block" unwind label %exception',
		'"call block":',
		'  %called = callbr i32 asm "", ""()',
		'      to label %exit [label %indirect]',
		'exception:',
		'  resume { ptr, i32 } zeroinitializer',
		'exit:',
		'  ret void',
		'}',
	].join('\n'), '/project');

	assert.deepEqual(result.diagnostics, []);
	const [graph] = result.graphs;
	assert.equal(graph.edges.find(edge => edge.from === 'entry' && edge.to === 'indirect')?.label, 'default');
	assert.ok(graph.edges.some(edge => edge.from === 'entry' && edge.to === 'invoke.block' && edge.label === 'i32 0'));
	assert.ok(graph.edges.some(edge => edge.from === 'indirect' && edge.to === 'call block'));
	assert.ok(graph.edges.some(edge => edge.from === 'invoke.block' && edge.to === 'exception' && edge.kind === 'exception'));
	assert.ok(graph.edges.some(edge => edge.from === 'call block' && edge.to === 'indirect' && edge.label === 'indirect'));
	assert.equal(graph.nodes.find(node => node.id === 'exception')?.terminal, 'resume');
	assert.equal(graph.nodes.find(node => node.id === 'exit')?.terminal, 'return');
});

test('GCC CFG parser handles successor comments and conservative branch edges', () => {
	const result = parseGccControlFlowGraphs([
		';; Function choose (choose, funcdef_no=0)',
		'',
		'<bb 2>:',
		'if (condition != 0)',
		'  goto <bb 3>; [INV]',
		'else',
		'  goto <bb 4>; [INV]',
		';; 2 successors { 3 4 }',
		'',
		'<bb 3>:',
		'return value;',
		';; 3 successors { 1 }',
		'',
		'<bb 4>:',
		'__builtin_unreachable ();',
		';; 4 successors { 1 }',
		'',
		'<bb 1>:',
		'',
	].join('\n'), '/project');

	assert.equal(result.graphs.length, 1);
	assert.equal(result.graphs[0].id, 'gcc:choose');
	assert.ok(result.graphs[0].nodes.some(node => node.terminal === 'return'));
	assert.ok(result.graphs[0].nodes.some(node => node.terminal === 'unreachable'));
	assert.ok(result.graphs[0].edges.some(edge => edge.kind === 'true'));
	assert.ok(result.graphs[0].edges.some(edge => edge.kind === 'false'));
});

test('GCC CFG parser labels the compiler-created entry and exit blocks', () => {
	const result = parseGccControlFlowGraphs([
		';; Function bounds (bounds, funcdef_no=0)',
		'<bb 0>:',
		';; 0 successors { 2 }',
		'',
		'<bb 2>:',
		'return value;',
		';; 2 successors { 1 }',
		'',
		'<bb 1>:',
		'',
	].join('\n'), '/project');

	assert.equal(result.graphs.length, 1);
	assert.deepEqual(result.graphs[0].nodes.map(node => node.id), ['ENTRY', 'bb2', 'EXIT']);
	assert.equal(result.graphs[0].entryNodeId, result.graphs[0].nodes[0].id);
});

test('GCC CFG parser normalizes numeric switch targets and partial-dump fallthrough order', () => {
	const result = parseGccControlFlowGraphs([
		';; Function switcher (switcher, funcdef_no=0)',
		'<bb 2>:',
		'  value = 1;',
		';; 4 successors { 1 }',
		'<bb 3>:',
		'  return value;',
		'<bb 4>:',
		'  switch (value) <default: <bb 1>; case 0: <bb 3>>',
		'<bb 1>:',
	].join('\n'), '/project');

	assert.equal(result.diagnostics.length, 0);
	const [graph] = result.graphs;
	assert.deepEqual(graph.nodes.map(node => node.id), ['bb2', 'bb3', 'bb4', 'EXIT']);
	assert.ok(graph.edges.some(edge =>
		edge.from === 'bb2' && edge.to === 'bb3' && edge.kind === 'fallthrough'));
	assert.ok(graph.edges.some(edge =>
		edge.from === 'bb4' && edge.to === 'EXIT' && edge.label === 'default'));
});

test('GCC CFG parser resolves POSIX, Windows, and extensionless source locations independently of host paths', () => {
	const text = [
		';; Function locations (locations, funcdef_no=0)',
		'<bb 2>:',
		'  posix = 1; generated:12:3',
	].join('\n');

	const posix = parseGccControlFlowGraphs(text, '/project');
	const posixSource = posix.graphs[0].nodes[0].source;
	assert.equal(posixSource?.uri, 'file:///project/generated');
	assert.equal(posixSource?.line, 11);
	assert.equal(posixSource?.column, 2);

	const windows = parseGccControlFlowGraphs([
		';; Function locations (locations, funcdef_no=0)',
		'<bb 2>:',
		'  windows = 2; C:\\work dir\\generated:7:5',
	].join('\n'), 'C:\\project');
	const windowsSource = windows.graphs[0].nodes[0].source;
	assert.equal(windowsSource?.uri, 'file:///C:/work%20dir/generated');
	assert.equal(windowsSource?.line, 6);
	assert.equal(windowsSource?.column, 4);
});

test('Rust MIR CFG parser recognizes switch successors and terminal blocks', () => {
	const result = parseRustMirControlFlowGraphs([
		'fn choose(_1: bool) -> i32 {',
		'    bb0: {',
		'        switchInt(copy _1) -> [0: bb2, otherwise: bb1];',
		'    }',
		'    bb1: {',
		'        return;',
		'    }',
		'    bb2: {',
		'        goto -> bb1;',
		'    }',
		'}',
	].join('\n'), '/project');

	assert.deepEqual(result.diagnostics, []);
	assert.equal(result.graphs[0].label, 'choose');
	assert.deepEqual(result.graphs[0].nodes.map(node => node.id), ['bb0', 'bb1', 'bb2']);
	assert.ok(result.graphs[0].edges.some(edge => edge.label === '0' && edge.to === 'bb2'));
	assert.ok(result.graphs[0].nodes.some(node => node.id === 'bb1' && node.terminal === 'return'));
});

test('Rust MIR CFG parser recovers after an unclosed function and keeps diverging calls', () => {
	const result = parseRustMirControlFlowGraphs([
		'fn broken() -> () {',
		'    bb0: {',
		'        goto -> bb1;',
		'    }',
		'fn good() -> () {',
		'    bb0: {',
		'        _0 = panic() -> unwind continue;',
		'    }',
		'}',
	].join('\n'), '/project');

	assert.deepEqual(result.graphs.map(graph => graph.id), ['rust:good']);
	assert.equal(result.graphs[0].nodes[0].terminal, 'throw');
	assert.ok(result.diagnostics.some(message => /broken.*not closed/u.test(message)));
});

test('Rust MIR CFG parser distinguishes normal and unwind paths across terminator families', () => {
	const result = parseRustMirControlFlowGraphs([
		'fn paths(_1: bool) -> () {',
		'    bb0: {',
		'        switchInt(copy _1) -> [0: bb7, otherwise: bb1];',
		'    }',
		'    bb1: {',
		'        _0 = foo() -> [return: bb2, unwind: bb5];',
		'    }',
		'    bb2: {',
		'        drop(_1) -> [return: bb3, unwind: bb5];',
		'    }',
		'    bb3: {',
		'        assert(copy _1, "bad") -> [success: bb4, unwind: bb5];',
		'    }',
		'    bb4: {',
		'        _0 = yield(copy _1) -> [resume: bb6, drop: bb5];',
		'    }',
		'    bb5: {',
		'        resume;',
		'    }',
		'    bb6: {',
		'        return;',
		'    }',
		'    bb7: {',
		'        abort;',
		'    }',
		'    bb8: {',
		'        unreachable;',
		'    }',
		'}',
	].join('\n'), '/project');

	assert.deepEqual(result.diagnostics, []);
	const [graph] = result.graphs;
	assert.ok(graph.edges.some(edge => edge.from === 'bb1' && edge.to === 'bb2' && edge.kind === 'return'));
	assert.ok(graph.edges.some(edge => edge.from === 'bb1' && edge.to === 'bb5' && edge.kind === 'exception'));
	assert.ok(graph.edges.some(edge => edge.from === 'bb3' && edge.to === 'bb4' && edge.kind === 'true'));
	assert.ok(graph.edges.some(edge => edge.from === 'bb4' && edge.to === 'bb5' && edge.kind === 'exception'));
	assert.equal(graph.nodes.find(node => node.id === 'bb5')?.terminal, 'resume');
	assert.equal(graph.nodes.find(node => node.id === 'bb6')?.terminal, 'return');
	assert.equal(graph.nodes.find(node => node.id === 'bb7')?.terminal, 'throw');
	assert.equal(graph.nodes.find(node => node.id === 'bb8')?.terminal, 'unreachable');
});

test('Python CFG parser accepts the isolated code-object payload and nested objects', () => {
	const instruction = (
		offset: number,
		overrides: Partial<Record<string, unknown>> = {},
	): Record<string, unknown> => ({
		offset,
		opname: 'NOP',
		argrepr: '',
		startsLine: offset + 1,
		line: offset + 1,
		endLine: offset + 1,
		column: 0,
		endColumn: 1,
		isJumpTarget: false,
		isJump: false,
		conditional: false,
		target: null,
		terminal: false,
		return: false,
		...overrides,
	});
	const payload = {
		codeObjects: [
			{
				name: '<module>',
				filename: 'source.py',
				firstLine: 1,
				instructions: [
					instruction(0, {
						opname: 'POP_JUMP_FORWARD_IF_FALSE',
						argrepr: 'to 4',
						isJump: true,
						conditional: true,
						target: 4,
					}),
					instruction(2, { opname: 'RETURN_VALUE', terminal: true, return: true }),
					instruction(4, { opname: 'RETURN_VALUE', terminal: true, return: true, isJumpTarget: true }),
				],
				exceptions: [{ start: 0, end: 2, target: 4, depth: 1, lasti: false }],
			},
			{
				name: 'nested',
				filename: 'source.py',
				firstLine: 5,
				instructions: [],
				exceptions: [],
			},
			{ name: 'malformed' },
		],
	};

	const result = parsePythonControlFlowGraphs(JSON.stringify(payload), '/project');
	assert.equal(result.graphs.length, 2);
	assert.ok(result.diagnostics.some(message => /malformed Python code object/u.test(message)));
	const module = result.graphs[0];
	assert.equal(module.label, '<module>');
	assert.ok(module.edges.some(edge => edge.kind === 'true'));
	assert.ok(module.edges.some(edge => edge.kind === 'false'));
	assert.equal(module.edges.find(edge => edge.to === 'offset:4' && edge.kind !== 'exception')?.kind, 'false');
	assert.equal(module.edges.find(edge => edge.to === 'offset:2')?.kind, 'true');
	assert.ok(module.edges.some(edge => edge.kind === 'exception'));
	assert.ok(module.nodes.some(node => node.terminal === 'return'));
	assert.deepEqual(module.nodes[0].referencedArtifactLines, [0]);
	assert.equal(module.nodes[0].source?.line, 0);
});

test('Python CFG parser reports unknown targets and splits exception ranges at the next instruction', () => {
	const instruction = (
		offset: number,
		overrides: Partial<Record<string, unknown>> = {},
	): Record<string, unknown> => ({
		offset,
		opname: 'NOP',
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
		terminal: false,
		return: false,
		...overrides,
	});
	const result = parsePythonControlFlowGraphs(JSON.stringify({
		codeObjects: [
			{
				name: 'boundary',
				filename: 'source.py',
				firstLine: 1,
				instructions: [
					instruction(0),
					instruction(2),
					instruction(4),
					instruction(8, { opname: 'RETURN_VALUE', terminal: true, return: true, isJumpTarget: true }),
				],
				exceptions: [{ start: 0, end: 3, target: 8, depth: 0, lasti: false }],
			},
			{
				name: 'partial',
				filename: 'source.py',
				firstLine: 1,
				instructions: [
					instruction(0, { opname: 'JUMP_FORWARD', isJump: true, target: 99 }),
					instruction(2, { opname: 'RETURN_VALUE', terminal: true, return: true }),
				],
				exceptions: [{ start: 0, end: 2, target: 88, depth: 1, lasti: true }],
			},
		],
	}), '/project');

	const boundary = result.graphs[0];
	assert.equal(result.graphs.length, 1);
	assert.deepEqual(boundary.nodes.map(node => node.id), ['offset:0', 'offset:4', 'offset:8']);
	assert.deepEqual(boundary.nodes[1].referencedArtifactLines, [4]);
	assert.ok(result.diagnostics.some(message => /unknown jump target offset 99/u.test(message)));
	assert.ok(result.diagnostics.some(message => /unknown exception target offset 88/u.test(message)));
});

test('Python CFG parser normalizes POSIX and Windows source URIs independently of the host', () => {
	const instruction = (offset: number): Record<string, unknown> => ({
		offset,
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
	});
	const payload = (filename: string) => JSON.stringify({
		codeObjects: [{
			name: 'source',
			filename,
			firstLine: 1,
			instructions: [instruction(0)],
			exceptions: [],
		}],
	});

	assert.equal(
		parsePythonControlFlowGraphs(payload('src/file name.py'), '/project').graphs[0].nodes[0].source?.uri,
		'file:///project/src/file%20name.py',
	);
	assert.equal(
		parsePythonControlFlowGraphs(payload('src\\file name.py'), 'C:\\project').graphs[0].nodes[0].source?.uri,
		'file:///C:/project/src/file%20name.py',
	);
	assert.equal(
		parsePythonControlFlowGraphs(payload('/repo/src/file name.py'), 'C:\\project').graphs[0].nodes[0].source?.uri,
		'file:///repo/src/file%20name.py',
	);
	assert.equal(
		parsePythonControlFlowGraphs(payload('C:\\repo\\src file.py'), '/project').graphs[0].nodes[0].source?.uri,
		'file:///C:/repo/src%20file.py',
	);
});

test('control-flow graph availability covers every planned toolchain cell', () => {
	// MSVC is included: it has no IR dump, but its `/FAcs` assembly listing is
	// enough to build a machine-level graph.
	const kinds = ['gcc', 'clang', 'apple-clang', 'clang-cl', 'rust', 'python', 'msvc'] as const;
	for (const kind of kinds) {
		assert.equal(
			resolveArtifactAvailability(profile(kind), 'control-flow-graph').status,
			'available',
			`${kind} should expose a CFG producer`,
		);
	}
});

test('toolchains advertise every supported control-flow graph output', () => {
	const outputs = (kind: ToolchainKind) =>
		getArtifactOutputChoices(profile(kind), 'control-flow-graph')
			.map(output => output.id);

	assert.deepEqual(outputs('gcc'), ['gcc-tree', 'assembly']);
	for (const kind of ['clang', 'apple-clang', 'clang-cl'] as const) {
		assert.deepEqual(outputs(kind), ['llvm-ir', 'assembly']);
	}
	assert.deepEqual(outputs('rust'), ['rust-mir', 'llvm-ir', 'assembly']);
	assert.deepEqual(outputs('msvc'), ['assembly']);
	assert.deepEqual(outputs('python'), ['python-bytecode']);
	assert.equal(
		resolveArtifactOutput(profile('rust'), 'control-flow-graph').status,
		'unsupported',
	);
	assert.equal(
		resolveArtifactOutput(profile('rust'), 'control-flow-graph', 'unknown').status,
		'unsupported',
	);
});

test('Rust control-flow graph outputs select MIR, LLVM IR, or assembly production', async () => {
	for (const [outputId, expectedSpec] of [
		['rust-mir', rustMirOutput],
		['llvm-ir', rustLlvmIrOutput],
	] as const) {
		let receivedSpec: unknown;
		const fakeBackend = {
			produceCompilerOutput: async (
				_kind: ArtifactKind,
				_source: unknown,
				_options: unknown,
				spec: unknown,
			) => {
				receivedSpec = spec;
				return rawArtifact('control-flow-graph', '');
			},
		};
		const output = resolveArtifactOutput(profile('rust'), 'control-flow-graph', outputId);
		assert.equal(output.status, 'available');
		if (output.status === 'available') {
			await output.producer(
				fakeBackend as never,
				{} as never,
				{ productionOptions: { intel: false, demangle: false } },
				{} as never,
			);
		}
		assert.equal(receivedSpec, expectedSpec);
	}

	let producedAssembly = false;
	const assemblyBackend = {
		produceAssembly: async () => {
			producedAssembly = true;
			return rawArtifact('assembly', '');
		},
	};
	const assembly = resolveArtifactOutput(profile('rust'), 'control-flow-graph', 'assembly');
	assert.equal(assembly.status, 'available');
	if (assembly.status === 'available') {
		const raw = await assembly.producer(
			assemblyBackend as never,
			{} as never,
			{ productionOptions: { intel: false, demangle: false } },
			{} as never,
		);
		assert.equal(raw.kind, 'control-flow-graph');
	}
	assert.equal(producedAssembly, true);
});

test('selected Rust CFG outputs dispatch to their matching parsers', () => {
	assert.throws(
		() => renderControlFlowGraphArtifact(
			rawArtifact('control-flow-graph', ''),
			{} as never,
			{
				backend: { profile: profile('rust') } as never,
				source: {
					uri: { scheme: 'file', toString: () => 'file:///project/source.rs' } as never,
					text: '',
				},
			},
		),
		/control-flow graph output must be selected/u,
	);

	const llvm = renderControlFlowGraphArtifact(
		rawArtifact('control-flow-graph', [
			'define void @selected() {',
			'entry:',
			'  ret void',
			'}',
		].join('\n')),
		{} as never,
		{
			artifactOutputId: 'llvm-ir',
			backend: { profile: profile('rust') } as never,
			source: {
				uri: { scheme: 'file', toString: () => 'file:///project/source.rs' } as never,
				text: '',
			},
		},
	);
	assert.deepEqual(llvm.graphs.map(graph => graph.id), ['llvm:selected']);

	const parsedAssembly = {
		asm: [
			{ text: 'selected:' },
			{ text: '\tje\t.LBB0_1', source: { file: null, line: 1, column: 1 } },
			{ text: '\tret', source: { file: null, line: 2, column: 1 } },
			{ text: '.LBB0_1:' },
			{ text: '\tret', source: { file: null, line: 3, column: 1 } },
		],
		labelDefinitions: {},
	};
	const assembly = renderControlFlowGraphArtifact(
		rawArtifact('control-flow-graph', ''),
		{} as never,
		{
			artifactOutputId: 'assembly',
			backend: {
				profile: profile('rust'),
				parseAssembly: () => parsedAssembly,
			} as never,
			source: {
				uri: { scheme: 'file', toString: () => 'file:///project/source.rs' } as never,
				text: '',
			},
		},
	);
	assert.deepEqual(assembly.graphs.map(graph => graph.id), ['clang-asm:selected']);
	assert.deepEqual(assembly.graphs[0].edges.map(edge => edge.kind), ['true', 'false']);
});

test('installed rustc assembly output produces a machine-level CFG', t => {
	if (!commandExists('rustc')) {
		t.diagnostic('rustc is not installed; skipping the assembly CFG integration probe');
		return;
	}
	const source = path.resolve('test/fixtures/front-end/source.rs');
	const result = childProcess.spawnSync(
		'rustc',
		[
			'--crate-name=coglens_cfg_probe',
			'--crate-type=lib',
			'--emit=asm=-',
			'-C',
			'debuginfo=1',
			source,
		],
		{ encoding: 'utf8', windowsHide: true },
	);
	assert.equal(result.status, 0, result.stderr);
	const backend = new ToolchainBackend(profile('rust'), toolchainDefinitions.rust);
	const rendered = renderControlFlowGraphArtifact(
		rawArtifact('control-flow-graph', result.stdout),
		defaultArtifactOptions.display,
		{
			artifactOutputId: 'assembly',
			backend,
			source: {
				uri: { scheme: 'file', toString: () => `file:///${source.replaceAll('\\', '/')}` } as never,
				text: '',
			},
		},
	);
	assert.ok(rendered.graphs.some(graph => graph.label.includes('choose')));
	assert.ok(rendered.graphs.some(graph => graph.edges.length >= 2));
});

test('GCC CFG production owns its dump and temporary object arguments exactly', () => {
	const temporaryDirectory = path.join('/temporary', 'coglens');
	const outputFile = path.join(temporaryDirectory, 'output.cfg');
	assert.equal(gccControlFlowGraphOutput.outputFilename, 'output.cfg');
	assert.deepEqual(
		gccControlFlowGraphOutput.arguments(outputFile, temporaryDirectory, ['-fdump-tree-cfg=provider.cfg']),
		[
			'-c',
			`-fdump-tree-cfg=${outputFile}`,
			'-o',
			path.join(temporaryDirectory, 'output.o'),
		],
	);
});

test('LLVM and MIR CFG cells dispatch through the expected compiler output specs', async () => {
	const cases = [
		{
			kind: 'clang' as const,
			outputId: 'llvm-ir',
			outputFilename: 'output.ll',
			expectedArguments: ['-emit-llvm', '-S', '-gline-tables-only', '-o', 'cfg.ll'],
		},
		{
			kind: 'apple-clang' as const,
			outputId: 'llvm-ir',
			outputFilename: 'output.ll',
			expectedArguments: ['-emit-llvm', '-S', '-gline-tables-only', '-o', 'cfg.ll'],
		},
		{
			kind: 'clang-cl' as const,
			outputId: 'llvm-ir',
			outputFilename: 'output.ll',
			expectedArguments: [
				'/clang:-emit-llvm',
				'/clang:-S',
				'/clang:-gline-tables-only',
				'/clang:-o',
				'/clang:cfg.ll',
			],
		},
		{
			kind: 'rust' as const,
			outputId: 'rust-mir',
			outputFilename: 'output.mir',
			expectedArguments: [
				'--crate-name=coglens_artifact',
				'--crate-type=lib',
				'--emit=mir=cfg.mir',
				'--error-format=human',
				'--color=never',
			],
		},
	] as const;

	for (const item of cases) {
		let receivedKind: ArtifactKind | undefined;
		let receivedOutputFilename: string | undefined;
		let receivedArguments: readonly string[] | undefined;
		const fakeBackend = {
			produceCompilerOutput: async (
				kind: ArtifactKind,
				_source: unknown,
				_options: unknown,
				spec: {
					outputFilename: string;
					arguments: (
						outputFile: string,
						temporaryDirectory: string,
						providerArguments: readonly string[],
					) => readonly string[];
				},
			) => {
				receivedKind = kind;
				receivedOutputFilename = spec.outputFilename;
				receivedArguments = spec.arguments(
				item.outputFilename === 'output.mir' ? 'cfg.mir' : 'cfg.ll',
				'/temporary',
				[],
			);
				return rawArtifact('control-flow-graph', '');
			},
		};
		const cell = resolveArtifactOutput(
			profile(item.kind),
			'control-flow-graph',
			item.outputId,
		);
		assert.equal(cell.status, 'available');
		if (cell.status !== 'available') {
			continue;
		}
		await cell.producer(
			fakeBackend as never,
			{} as never,
			{ productionOptions: { intel: false, demangle: false } },
			{} as never,
		);
		assert.equal(receivedKind, 'control-flow-graph');
		assert.equal(receivedOutputFilename, item.outputFilename);
		assert.deepEqual(receivedArguments, item.expectedArguments);
	}

	assert.deepEqual(llvmIrOutput.arguments('cfg.ll', '/temporary', []), [
		'-emit-llvm', '-S', '-gline-tables-only', '-o', 'cfg.ll',
	]);
	assert.deepEqual(rustMirOutput.arguments('cfg.mir', '/temporary', []), [
		'--crate-name=coglens_artifact',
		'--crate-type=lib',
		'--emit=mir=cfg.mir',
		'--error-format=human',
		'--color=never',
	]);
});

test('Python CFG producer owns isolated execution arguments and compiles the fixture without executing it', async t => {
	let receivedKind: ArtifactKind | undefined;
	let receivedArguments: readonly string[] | undefined;
	const fakeBackend = {
		produceStdoutArtifact: async (
			kind: ArtifactKind,
			_source: unknown,
			_options: unknown,
			spec: { arguments: (temporaryDirectory: string, providerArguments: readonly string[]) => readonly string[] },
		) => {
			receivedKind = kind;
			receivedArguments = spec.arguments('/temporary', []);
			return rawArtifact('control-flow-graph', '');
		},
	};
	await pythonControlFlowGraphProducer(
		fakeBackend as never,
		{} as never,
		{ productionOptions: { intel: false, demangle: false } },
		{} as never,
	);
	assert.equal(receivedKind, 'control-flow-graph');
	assert.deepEqual(receivedArguments, ['-I', '-c', pythonCfgHelper]);
	assert.match(pythonCfgHelper, /compile\(source,filename,"exec"/u);
	assert.doesNotMatch(pythonCfgHelper, /import_module|exec\(/u);

	if (!commandExists('python')) {
		t.diagnostic('python is not installed; skipping the real CFG helper probe');
		return;
	}
	const source = path.resolve('test/fixtures/control-flow/python.py');
	const result = childProcess.spawnSync(
		'python',
		['-I', '-c', pythonCfgHelper, source],
		{ encoding: 'utf8', windowsHide: true },
	);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /"codeObjects"/u);
	assert.doesNotMatch(result.stderr, /Cogitator Lens must compile, not execute|RuntimeError/u);
	const parsed = parsePythonControlFlowGraphs(result.stdout, path.dirname(source));
	assert.equal(parsed.diagnostics.length, 0);
	assert.ok(parsed.graphs.length >= 5);
	assert.ok(parsed.graphs.some(graph => graph.label.includes('inner')));
	assert.ok(parsed.graphs.some(graph =>
		graph.edges.some(edge => edge.kind === 'true')
		&& graph.edges.some(edge => edge.kind === 'false')));
	const generator = parsed.graphs.find(graph => graph.label === 'classify');
	assert.ok(generator);
	assert.match(generator.nodes[0].label, /RETURN_GENERATOR/u);
	assert.equal(generator.nodes[0].terminal, undefined);
	assert.equal(controlFlowGraphMetrics([generator]).unreachableNodeCount, 0);
	assert.ok(parsed.graphs.some(graph =>
		graph.nodes.some(node => node.terminal === 'throw')));
});

test('webview graph protocol accepts exact schemas and rejects unknown or dangerous fields', () => {
	const graph = {
		id: 'g',
		label: 'graph',
		entryNodeId: 'entry',
		nodes: [{ id: 'entry', label: 'entry' }],
		edges: [],
	};
	const artifact = {
		graphs: [graph],
		metrics: { graphCount: 1 },
		diagnostics: [],
		stale: false,
	};

	assert.deepEqual(parseWebviewMessage({ type: 'ready' }), { type: 'ready' });
	assert.deepEqual(
		parseWebviewMessage({ type: 'openSource', graphId: 'g', nodeId: 'entry' }),
		{ type: 'openSource', graphId: 'g', nodeId: 'entry' },
	);
	assert.equal(parseWebviewMessage({ type: 'ready', extra: true }), undefined);
	assert.equal(parseWebviewMessage({ type: 'openSource', graphId: '', nodeId: 'entry' }), undefined);
	assert.equal(parseWebviewMessage({ type: 'unknown' }), undefined);

	assert.deepEqual(
		parseHostMessage({ type: 'render', artifact, selectedGraphId: 'g' }),
		{ type: 'render', artifact, selectedGraphId: 'g' },
	);
	assert.deepEqual(parseHostMessage({ type: 'theme', theme: 'high-contrast' }), {
		type: 'theme',
		theme: 'high-contrast',
	});
	assert.equal(parseHostMessage({ type: 'theme', theme: 'blue' }), undefined);
	assert.equal(parseHostMessage({ type: 'render', artifact, injected: '<script>' }), undefined);
	assert.equal(parseHostMessage({
		type: 'render',
		artifact: { ...artifact, graphs: [{ ...graph, nodes: [{ id: 'entry', label: 'entry', injected: true }] }] },
	}), undefined);
});

test('rendered artifact migration retains text presentation explicitly', () => {
	const raw = rawArtifact('assembly', 'ret');
	const rendered = renderedArtifact(raw, [{ text: 'ret' }]);
	assert.equal(rendered.presentation, 'text');
	assert.equal(rendered.text, 'ret');
	assert.equal(rendered.raw, raw.text);
	assert.deepEqual(rendered.lines, [{ text: 'ret' }]);
});

function graph(
	id: string,
	label: string,
	options: {
		readonly source?: ControlFlowSourceLocation;
		readonly nodes: readonly ControlFlowNode[];
		readonly edges: readonly ControlFlowEdge[];
	},
): ControlFlowGraph {
	const nodes = options.nodes.map((node, index) =>
		index === 0 && options.source
			? { ...node, source: options.source }
			: node);
	return {
		id,
		label,
		entryNodeId: String(nodes[0].id),
		nodes,
		edges: options.edges,
	};
}

function profile(kind: ToolchainKind): ToolchainProfile {
	return {
		id: `test:${kind}`,
		displayName: `Test ${kind}`,
		kind,
		executable: process.execPath,
		defaultArguments: [],
		environment: {},
		tools: {},
	};
}

function commandExists(command: string): boolean {
	return childProcess.spawnSync(command, ['--version'], {
		stdio: 'ignore',
		windowsHide: true,
	}).status === 0;
}

function rawArtifact(kind: ArtifactKind, text: string): RawArtifact {
	return {
		kind,
		text,
		diagnostics: [],
		durationMs: 1,
		generatedAt: 0,
		command: {
			executable: process.execPath,
			arguments: [],
			environmentVariableNames: [],
			workingDirectory: path.resolve('/project'),
		},
		truncated: false,
		inputs: [],
		dependencyCoverage: 'source-only',
	};
}
