import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { toAssemblyLines } from '../src/artifacts/control-flow-graph/parsers/assembly-line.js';
import type { AssemblyLine } from '../src/artifacts/control-flow-graph/parsers/assembly-line.js';
import {
	ClangAssemblyCfgParser,
	GccAssemblyCfgParser,
	MsvcAssemblyCfgParser,
} from '../src/artifacts/control-flow-graph/parsers/assembly-dialects.js';
import {
	ArmInstructionSetInfo,
	InstructionSetInfo,
	MsvcInstructionSetInfo,
} from '../src/artifacts/control-flow-graph/parsers/instruction-sets.js';
import { validateControlFlowGraphs } from '../src/artifacts/control-flow-graph/control-flow-graph-model.js';
import { noopPropertyGetter } from '../src/vendor/compiler-props.js';
import { VcAsmParser } from '../src/vendor/lib/parsers/asm-parser-vc.js';
import type { ParseFiltersAndOutputOptions } from '../src/vendor/types/features/filters.interfaces.js';

const fixture = (name: string): string =>
	fs.readFileSync(path.join('test', 'fixtures', 'control-flow', name), 'utf8');

/**
 * Builds parser input from a listing.
 *
 * Assembly parsers attribute instructions to source lines but leave directives
 * and labels unattributed, and the dialect filters rely on that distinction, so
 * the fixture reproduces it: indented lines that are not directives get a
 * source.
 */
function assemblyLines(listing: string, uri = 'file:///work/main.c'): AssemblyLine[] {
	return listing.split('\n').map((text, index) => ({
		text,
		artifactLine: index,
		...(/^\s+[^\s.]/u.test(text) ? { source: { uri, line: index, column: 0 } } : {}),
	}));
}

test('MSVC listings become graphs through the toolchain assembly parser', () => {
	const parsed = new VcAsmParser(noopPropertyGetter)
		.process(fixture('msvc-listing.asm'), {} as ParseFiltersAndOutputOptions);
	const result = new MsvcAssemblyCfgParser()
		.parse(toAssemblyLines(parsed.asm, 'file:///C:/work/main.c', 'C:\\work'));

	assert.deepEqual(result.diagnostics, []);
	assert.equal(result.graphs.length, 1);
	const graph = result.graphs[0];
	// The graph is named for the function, not for the `PROC` directive line.
	assert.equal(graph.label, 'classify');
	assert.equal(graph.id, 'msvc-asm:classify');
	assert.equal(graph.entryNodeId, 'classify');
	assert.deepEqual(
		graph.nodes.map(node => node.id),
		['classify', 'classify#4', '$LN2@classify:', '$LN3@classify:'],
	);
	// Upstream's edge is a colour; each branch role is recoverable here.
	assert.deepEqual(graph.edges, [
		{ from: 'classify', to: '$LN2@classify:', kind: 'true' },
		{ from: 'classify', to: 'classify#4', kind: 'false' },
		{ from: 'classify#4', to: '$LN3@classify:', kind: 'unconditional' },
		{ from: '$LN2@classify:', to: '$LN3@classify:', kind: 'fallthrough' },
	]);
	// `ret` is the block's last instruction only because `ENDP` is kept outside
	// the function range.
	assert.equal(graph.nodes.at(-1)?.terminal, 'return');
});

test('MSVC graph nodes carry the source position and the artifact lines behind them', () => {
	const parsed = new VcAsmParser(noopPropertyGetter)
		.process(fixture('msvc-listing.asm'), {} as ParseFiltersAndOutputOptions);
	const lines = toAssemblyLines(parsed.asm, 'file:///C:/work/main.c', 'C:\\work');
	const graph = new MsvcAssemblyCfgParser().parse(lines).graphs[0];

	const entry = graph.nodes[0];
	// `; Line 4` in the listing is the zero-based editor line 3.
	assert.deepEqual(entry.source, { uri: 'file:///C:/work/main.c', line: 3, column: 0 });
	assert.deepEqual(
		entry.referencedArtifactLines?.map(index => parsed.asm[index].text.trim()),
		['mov     DWORD PTR [rsp+8], ecx', 'cmp     DWORD PTR value$[rsp], 10', 'jle     SHORT $LN2@classify'],
	);
	assert.equal(graph.nodes.every(node => node.source !== undefined), true);
});

test('MSVC /FAcs address and machine-code columns do not hide control flow', () => {
	const listing = [
		'; Function compile flags: /Odtp',
		'classify PROC',
		'$LN4@classify:',
		'  00000\t83 f9 0a\t cmp\t ecx, 10',
		'  00003\t0f 8e 07 00 00',
		'\t00\t\t jle\t $LN2@classify',
		'  00009\tb8 01 00 00 00\t mov\t eax, 1',
		'  0000e\teb 05\t\t jmp\t SHORT $LN3@classify',
		'$LN2@classify:',
		'  00010\t33 c0\t\t xor\t eax, eax',
		'$LN3@classify:',
		'  00012\tc3\t\t ret\t 0',
		'classify ENDP',
	].join('\n');

	const result = new MsvcAssemblyCfgParser().parse(assemblyLines(listing));

	assert.deepEqual(result.diagnostics, []);
	assert.deepEqual(result.graphs[0].edges, [
		{ from: '$LN4@classify:', to: '$LN2@classify:', kind: 'true' },
		{ from: '$LN4@classify:', to: '$LN4@classify:#5', kind: 'false' },
		{ from: '$LN4@classify:#5', to: '$LN3@classify:', kind: 'unconditional' },
		{ from: '$LN2@classify:', to: '$LN3@classify:', kind: 'fallthrough' },
	]);
	assert.equal(result.graphs[0].nodes.at(-1)?.terminal, 'return');
});

test('a final linear MSVC block does not fall through to its ENDP directive', () => {
	const listing = [
		'; Function compile flags: /Odtp',
		'final_linear PROC',
		'\tnop',
		'final_linear ENDP',
	].join('\n');

	const result = new MsvcAssemblyCfgParser().parse(assemblyLines(listing));

	assert.deepEqual(result.diagnostics, []);
	assert.deepEqual(result.graphs[0].edges, []);
});

test('an indirect jump is reported instead of producing an edge to a missing block', () => {
	// A switch jump table reaches its targets through a table load. Upstream
	// stringifies the failed match and emits an edge to a node called `null:`,
	// which makes the whole graph unusable.
	const listing = [
		'; Function compile flags: /Odtp',
		'dispatch PROC',
		'\tmov\teax, DWORD PTR value$[rsp]',
		'\tjmp\tQWORD PTR $LN9@dispatch[rax*8]',
		'$LN2@dispatch:',
		'\tret\t0',
		'dispatch ENDP',
	].join('\n');

	const result = new MsvcAssemblyCfgParser().parse(assemblyLines(listing));

	assert.equal(result.graphs.length, 1);
	assert.deepEqual(result.graphs[0].edges, []);
	assert.equal(result.diagnostics.length, 1);
	assert.match(result.diagnostics[0], /no block named "\$LN9@dispatch\[rax\*8\]:" exists/u);
	// The graph is still well formed, so it is not discarded downstream.
	assert.equal(validateControlFlowGraphs(result.graphs).graphs.length, 1);
});

test('a function that cannot be parsed does not suppress the others', () => {
	const listing = [
		'broken PROC',
		'\tjmp\t$LNmissing@broken',
		'broken ENDP',
		'good PROC',
		'\tret\t0',
		'good ENDP',
	].join('\n');

	const result = new MsvcAssemblyCfgParser().parse(assemblyLines(listing));

	assert.deepEqual(result.graphs.map(graph => graph.label), ['broken', 'good']);
	assert.equal(result.graphs[0].edges.length, 0);
	assert.equal(result.diagnostics.length, 1);
});

test('clang assembly splits blocks at LBB labels and types every edge', () => {
	const listing = [
		'\t.text',
		'\t.file\t"main.c"',
		'\t.globl\tclassify',
		'classify:',
		'\t.cfi_startproc',
		'\tmovl\t%edi, -8(%rbp)',
		'\tcmpl\t$10, -8(%rbp)',
		'\tjle\t.LBB0_2',
		'\tmovl\t-8(%rbp), %eax',
		'\tjmp\t.LBB0_3',
		'.LBB0_2:',
		'\tmovl\t-8(%rbp), %eax',
		'\tnegl\t%eax',
		'.LBB0_3:',
		'\tmovl\t-4(%rbp), %eax',
		'\tretq',
		'.Lfunc_end0:',
	].join('\n');

	const result = new ClangAssemblyCfgParser(new InstructionSetInfo())
		.parse(assemblyLines(listing));

	assert.deepEqual(result.diagnostics, []);
	assert.equal(result.graphs.length, 1);
	const graph = result.graphs[0];
	assert.equal(graph.id, 'clang-asm:classify');
	assert.deepEqual(
		graph.nodes.map(node => node.id),
		['classify', 'classify@4', '.LBB0_2:', '.LBB0_3:'],
	);
	assert.deepEqual(
		graph.edges.map(edge => edge.kind),
		['true', 'false', 'unconditional', 'fallthrough'],
	);
	// A tab-indented `retq` is a return; upstream's `' ret'` substring test is not.
	assert.equal(graph.nodes.at(-1)?.terminal, 'return');
	// Directives and CFI pseudo-instructions never reach a node.
	assert.equal(graph.nodes.some(node => node.label.includes('.cfi_startproc')), false);
});

test('the GCC dialect keeps only labels that own an instruction', () => {
	const listing = [
		'classify():',
		'\tcmpl\t$10, -8(%rbp)',
		'\tjle\t.L2',
		'.L0:',
		'\t.cfi_def_cfa_offset 16',
		'.L1:',
		'\tmovl\t-8(%rbp), %eax',
		'\tret',
		'.L2:',
		'\tnegl\t%eax',
		'\tret',
	].join('\n');

	const result = new GccAssemblyCfgParser(new InstructionSetInfo()).parse(assemblyLines(listing));
	const graph = result.graphs[0];

	assert.deepEqual(result.diagnostics, []);
	// `.L0` owns only a directive, so it never becomes a block.
	assert.deepEqual(graph.nodes.map(node => node.id), ['classify()', '.L1:', '.L2:']);
	assert.equal(graph.nodes.some(node => node.label.includes('.L0')), false);
	assert.deepEqual(graph.edges, [
		{ from: 'classify()', to: '.L2:', kind: 'true' },
		{ from: 'classify()', to: '.L1:', kind: 'false' },
	]);
	assert.deepEqual(
		graph.nodes.map(node => node.terminal),
		[undefined, 'return', 'return'],
	);
});

test('instruction classification distinguishes the dialects it is asked about', () => {
	const base = new InstructionSetInfo();
	assert.equal(base.classify('\tjmp\t.L4'), 'unconditional-jump');
	assert.equal(base.classify('\tjle\t.L4'), 'conditional-jump');
	assert.equal(base.classify('\tretq'), 'return');
	assert.equal(base.classify('\trep ret'), 'return');
	assert.equal(base.classify('\tmovl\t%eax, %ebx'), 'linear');

	const msvc = new MsvcInstructionSetInfo();
	assert.equal(msvc.classify('\tjmp\tSHORT $LN3@f'), 'unconditional-jump');
	assert.equal(msvc.classify('\tjle\tSHORT $LN2@f'), 'conditional-jump');
	assert.equal(msvc.classify('\tret\t0'), 'return');
	assert.equal(msvc.classify('  0004a\teb 0a\t\t jmp\t SHORT $LN3@f'), 'unconditional-jump');
	assert.equal(msvc.classify('\t00\t\t jge\t $LN2@f'), 'conditional-jump');
	assert.equal(msvc.classify('  0004e\tc3\t\t ret\t 0'), 'return');
	// `jmp` appears inside no other MSVC mnemonic, but `mov` must not be a jump.
	assert.equal(msvc.classify('\tmov\teax, DWORD PTR value$[rsp]'), 'linear');

	const arm = new ArmInstructionSetInfo();
	assert.equal(arm.classify('\tb\t.LBB0_2'), 'unconditional-jump');
	assert.equal(arm.classify('\tb.le\t.LBB0_2'), 'conditional-jump');
	assert.equal(arm.classify('\tret'), 'return');
	// `bl` is a call, not a branch out of the block.
	assert.equal(arm.classify('\tbl\tprintf'), 'linear');
});
