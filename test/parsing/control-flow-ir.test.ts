import assert from 'node:assert/strict';
import test from 'node:test';
import { parseGccControlFlowGraphs } from '../../src/artifacts/control-flow-graph/parsers/gcc-cfg-parser.js';
import { parseGoSsaControlFlowGraphs } from '../../src/artifacts/control-flow-graph/parsers/go-ssa-cfg-parser.js';
import { parseLlvmControlFlowGraphs } from '../../src/artifacts/control-flow-graph/parsers/llvm-ir-cfg-parser.js';
import { parseRustMirControlFlowGraphs } from '../../src/artifacts/control-flow-graph/parsers/rust-mir-cfg-parser.js';

const listing = (...lines: readonly string[]): string => lines.join('\n');

test('LLVM: branches, quoted labels, terminals, and debug metadata become one graph', () => {
	const result = parseLlvmControlFlowGraphs(
		listing(
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
		),
		'/workspace',
	);

	assert.deepEqual(result.diagnostics, []);
	assert.equal(result.graphs.length, 1);
	const [graph] = result.graphs;
	assert.equal(graph.id, 'llvm:choose');
	// A node shows the IR it stands for, not just the block's name.
	assert.deepEqual(
		graph.nodes.map((node) => [node.id, node.label, node.terminal]),
		[
			['entry', 'entry:\nbr i1 %condition, label %"then.block", label %exit, !dbg !1', undefined],
			['then.block', 'then.block:\nret i32 1, !dbg !2', 'return'],
			['exit', 'exit:\nunreachable', 'unreachable'],
		],
	);
	assert.deepEqual(graph.edges, [
		{ from: 'entry', to: 'then.block', kind: 'true' },
		{ from: 'entry', to: 'exit', kind: 'false' },
	]);
	assert.deepEqual(graph.nodes[0].source, { uri: 'file:///project/main.c', line: 1, column: 2 });
	assert.deepEqual(graph.nodes[0].referencedArtifactLines, [1, 2]);
});

test('LLVM: switch, indirect, invoke, callbr, resume, and return terminators are all typed', () => {
	const result = parseLlvmControlFlowGraphs(
		listing(
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
		),
		'/project',
	);

	assert.deepEqual(result.diagnostics, []);
	const [graph] = result.graphs;
	const edge = (from: string, to: string) => graph.edges.find((item) => item.from === from && item.to === to);
	assert.equal(edge('entry', 'indirect')?.label, 'default');
	assert.equal(edge('entry', 'invoke.block')?.label, 'i32 0');
	assert.ok(edge('indirect', 'call block'));
	assert.equal(edge('invoke.block', 'exception')?.kind, 'exception');
	assert.equal(edge('call block', 'indirect')?.label, 'indirect');
	assert.equal(graph.nodes.find((node) => node.id === 'exception')?.terminal, 'resume');
	assert.equal(graph.nodes.find((node) => node.id === 'exit')?.terminal, 'return');
});

test('LLVM: a malformed function is omitted without suppressing the ones around it', () => {
	const result = parseLlvmControlFlowGraphs(
		listing(
			'define void @partial() {',
			'entry:',
			'  br label %missing',
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
		),
		'/project',
	);

	assert.deepEqual(
		result.graphs.map((graph) => graph.id),
		['llvm:exception_path'],
	);
	// `unwind to caller` leaves the function, so the handler edge is the only one.
	assert.deepEqual(result.graphs[0].edges, [{ from: 'entry', to: 'handler', kind: 'exception' }]);
	assert.deepEqual(
		result.graphs[0].nodes.map((node) => node.terminal),
		['resume', 'resume'],
	);
	// Each omission is explained, and the function it belongs to is named so the
	// reader can tell which definition in the listing was rejected.
	for (const name of ['partial', 'duplicate', 'bad_branch']) {
		assert.ok(
			result.diagnostics.some((message) => message.includes(JSON.stringify(name))),
			`${name} was omitted without a diagnostic`,
		);
	}
	assert.ok(!result.diagnostics.some((message) => message.includes(JSON.stringify('exception_path'))));
});

test('GCC: successor comments, conservative branch edges, and terminal blocks', () => {
	const result = parseGccControlFlowGraphs(
		listing(
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
		),
		'/project',
	);

	assert.equal(result.graphs.length, 1);
	const [graph] = result.graphs;
	assert.equal(graph.id, 'gcc:choose');
	assert.deepEqual(
		[...new Set(graph.nodes.map((node) => node.terminal))].sort(),
		[undefined, 'return', 'unreachable'].sort(),
	);
	assert.deepEqual([...new Set(graph.edges.map((edge) => edge.kind))].sort(), [
		'false',
		'return',
		'true',
		'unconditional',
	]);
});

test('GCC: compiler-created entry and exit blocks are labelled, numeric switch targets normalized', () => {
	const bounds = parseGccControlFlowGraphs(
		listing(
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
		),
		'/project',
	);
	assert.deepEqual(
		bounds.graphs[0].nodes.map((node) => node.id),
		['ENTRY', 'bb2', 'EXIT'],
	);
	assert.equal(bounds.graphs[0].entryNodeId, 'ENTRY');

	const switcher = parseGccControlFlowGraphs(
		listing(
			';; Function switcher (switcher, funcdef_no=0)',
			'<bb 2>:',
			'  value = 1;',
			';; 4 successors { 1 }',
			'<bb 3>:',
			'  return value;',
			'<bb 4>:',
			'  switch (value) <default: <bb 1>; case 0: <bb 3>>',
			'<bb 1>:',
		),
		'/project',
	);
	assert.deepEqual(switcher.diagnostics, []);
	const [graph] = switcher.graphs;
	assert.deepEqual(
		graph.nodes.map((node) => node.id),
		['bb2', 'bb3', 'bb4', 'EXIT'],
	);
	assert.ok(graph.edges.some((edge) => edge.from === 'bb2' && edge.to === 'bb3' && edge.kind === 'fallthrough'));
	assert.ok(graph.edges.some((edge) => edge.from === 'bb4' && edge.to === 'EXIT' && edge.label === 'default'));
});

test('GCC: POSIX and Windows source locations resolve independently of the host path style', () => {
	const posix = parseGccControlFlowGraphs(
		listing(';; Function locations (locations, funcdef_no=0)', '<bb 2>:', '  posix = 1; generated:12:3'),
		'/project',
	);
	assert.deepEqual(posix.graphs[0].nodes[0].source, {
		uri: 'file:///project/generated',
		line: 11,
		column: 2,
	});

	const windows = parseGccControlFlowGraphs(
		listing(
			';; Function locations (locations, funcdef_no=0)',
			'<bb 2>:',
			'  windows = 2; C:\\work dir\\generated:7:5',
		),
		'C:\\project',
	);
	assert.deepEqual(windows.graphs[0].nodes[0].source, {
		uri: 'file:///C:/work%20dir/generated',
		line: 6,
		column: 4,
	});
});

test('Rust MIR: switch successors, terminal blocks, and recovery from an unclosed function', () => {
	const choose = parseRustMirControlFlowGraphs(
		listing(
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
		),
		'/project',
	);
	assert.deepEqual(choose.diagnostics, []);
	assert.equal(choose.graphs[0].label, 'choose');
	assert.deepEqual(
		choose.graphs[0].nodes.map((node) => node.id),
		['bb0', 'bb1', 'bb2'],
	);
	assert.ok(choose.graphs[0].edges.some((edge) => edge.label === '0' && edge.to === 'bb2'));
	assert.equal(choose.graphs[0].nodes[1].terminal, 'return');

	const recovered = parseRustMirControlFlowGraphs(
		listing(
			'fn broken() -> () {',
			'    bb0: {',
			'        goto -> bb1;',
			'    }',
			'fn good() -> () {',
			'    bb0: {',
			'        _0 = panic() -> unwind continue;',
			'    }',
			'}',
		),
		'/project',
	);
	assert.deepEqual(
		recovered.graphs.map((graph) => graph.id),
		['rust:good'],
	);
	assert.equal(recovered.graphs[0].nodes[0].terminal, 'throw');
	assert.ok(recovered.diagnostics.some((message) => message.includes(JSON.stringify('broken'))));
});

test('Rust MIR: normal and unwind paths are distinguished across terminator families', () => {
	const result = parseRustMirControlFlowGraphs(
		listing(
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
		),
		'/project',
	);

	assert.deepEqual(result.diagnostics, []);
	const [graph] = result.graphs;
	const kind = (from: string, to: string) => graph.edges.find((e) => e.from === from && e.to === to)?.kind;
	assert.deepEqual(
		[kind('bb1', 'bb2'), kind('bb1', 'bb5'), kind('bb3', 'bb4'), kind('bb4', 'bb5')],
		['return', 'exception', 'true', 'exception'],
	);
	assert.deepEqual(
		['bb5', 'bb6', 'bb7', 'bb8'].map((id) => graph.nodes.find((node) => node.id === id)?.terminal),
		['resume', 'return', 'throw', 'unreachable'],
	);
});

test('Go SSA: the final pass wins, branches are typed, and blocks keep their source lines', () => {
	const result = parseGoSsaControlFlowGraphs(
		listing(
			'generating SSA for classify',
			'classify func(int) int',
			'  b1:',
			'    (+4) v1 = ArgIntReg <int> {value+0}',
			'    If v1 -> b2 b3 (likely)',
			'  b2:',
			'    (+5) Ret v1',
			'  b3:',
			'    (+7) Ret v2',
			'  pass trim begin',
			'  pass trim end [0 ns]',
			'classify func(int) int',
			'  b1:',
			'    (+4) v1 = TESTQ <flags>',
			'    If v1 -> b2 b3',
			'  b2:',
			'    (+5) Ret v1',
			'  b3:',
			'    (+7) Ret v2',
			'genssa classify',
		),
		'file:///project/source.go',
	);

	assert.equal(result.graphs.length, 1);
	assert.deepEqual(
		result.graphs[0].edges.map((edge) => edge.kind),
		['true', 'false'],
	);
	assert.equal(result.graphs[0].nodes[0].source?.line, 3);
	assert.match(result.graphs[0].nodes[0].label, /TESTQ/u);
	assert.doesNotMatch(result.graphs[0].nodes[0].label, /ArgIntReg/u);
});
