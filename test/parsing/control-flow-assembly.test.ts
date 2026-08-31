import assert from 'node:assert/strict';
import test from 'node:test';
import { toAssemblyLines, type AssemblyLine } from '../../src/artifacts/control-flow-graph/parsers/assembly-line.js';
import {
	ClangAssemblyCfgParser,
	GccAssemblyCfgParser,
	MsvcAssemblyCfgParser,
} from '../../src/artifacts/control-flow-graph/parsers/assembly-dialects.js';
import {
	ArmInstructionSetInfo,
	InstructionSetInfo,
	MsvcInstructionSetInfo,
} from '../../src/artifacts/control-flow-graph/parsers/instruction-sets.js';
import { validateControlFlowGraphs } from '../../src/artifacts/control-flow-graph/control-flow-graph-model.js';
import { noopPropertyGetter } from '../../src/vendor/compiler-props.js';
import { AsmParser } from '../../src/vendor/lib/parsers/asm-parser.js';
import { VcAsmParser } from '../../src/vendor/lib/parsers/asm-parser-vc.js';
import type { ParseFiltersAndOutputOptions } from '../../src/vendor/types/features/filters.interfaces.js';
import { readFixture } from '../support/environment.js';

const unfilteredParse = {
	labels: false,
	directives: false,
	commentOnly: false,
	libraryCode: false,
	dontMaskFilenames: true,
} as ParseFiltersAndOutputOptions;

/**
 * Builds parser input from a listing.
 *
 * Assembly parsers attribute instructions to source lines but leave directives
 * and labels unattributed, and the dialect filters rely on that distinction, so
 * the fixture reproduces it: indented lines that are not directives get a
 * source.
 */
function assemblyLines(listing: readonly string[], uri = 'file:///work/main.c'): AssemblyLine[] {
	return listing.map((text, index) => ({
		text,
		artifactLine: index,
		...(/^\s+[^\s.]/u.test(text) ? { source: { uri, line: index, column: 0 } } : {}),
	}));
}

test('vendored parsers keep opcodes and source mappings across the dialects they own', () => {
	for (const dialect of [
		{
			name: 'GNU',
			parser: new AsmParser(noopPropertyGetter),
			opcode: 'movl',
			sourceLine: 2,
			text: [
				'.file 1 "/project/path with spaces/ü" "main.cpp"',
				'.text',
				'.loc 1 2 5',
				'main:',
				'  movl $1, %eax',
				'  ret',
			],
		},
		{
			name: 'MSVC',
			parser: new VcAsmParser(noopPropertyGetter),
			opcode: 'mov eax',
			sourceLine: 3,
			text: [
				'; Function compile flags: /O2',
				'_TEXT SEGMENT',
				'?main@@YAHXZ PROC',
				'; File C:\\project path\\main.cpp',
				'; Line 3',
				'  mov eax, 1',
				'  ret 0',
				'?main@@YAHXZ ENDP',
				'_TEXT ENDS',
				'END',
			],
		},
		{
			name: 'Rust CodeView',
			parser: new AsmParser(noopPropertyGetter),
			opcode: 'imul',
			sourceLine: 3,
			text: [
				'.file "rust_fixture"',
				'.section .text',
				'.globl square',
				'square:',
				'.cv_func_id 0',
				'.cv_file 1 "C:\\project path\\source.rs"',
				'.cv_loc 0 1 3 0',
				'  imul eax, ecx',
				'  ret',
			],
		},
	]) {
		const result = dialect.parser.process(dialect.text.join('\n'), unfilteredParse);
		assert.ok(
			result.asm.some((line) => line.text.includes(dialect.opcode)),
			`${dialect.name} lost its opcode`,
		);
		assert.ok(
			result.asm.some((line) => line.source?.line === dialect.sourceLine),
			`${dialect.name} lost its source mapping`,
		);
	}
});

test('an MSVC listing becomes a graph through the toolchain assembly parser', () => {
	const parsed = new VcAsmParser(noopPropertyGetter).process(
		readFixture('control-flow', 'msvc-listing.asm'),
		unfilteredParse,
	);
	const result = new MsvcAssemblyCfgParser().parse(toAssemblyLines(parsed.asm, 'file:///C:/work/main.c', 'C:\\work'));

	assert.deepEqual(result.diagnostics, []);
	assert.equal(result.graphs.length, 1);
	const [graph] = result.graphs;
	// The graph is named for the function, not for the `PROC` directive line.
	assert.equal(graph.label, 'classify');
	assert.equal(graph.id, 'msvc-asm:classify');
	assert.equal(graph.entryNodeId, 'classify');
	assert.deepEqual(
		graph.nodes.map((node) => node.id),
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
	// `; Line 4` in the listing is the zero-based editor line 3.
	assert.deepEqual(graph.nodes[0].source, { uri: 'file:///C:/work/main.c', line: 3, column: 0 });
	assert.deepEqual(
		graph.nodes[0].referencedArtifactLines?.map((index) => parsed.asm[index].text.trim()),
		['mov     DWORD PTR [rsp+8], ecx', 'cmp     DWORD PTR value$[rsp], 10', 'jle     SHORT $LN2@classify'],
	);
	assert.ok(graph.nodes.every((node) => node.source !== undefined));
});

test('MSVC /FAcs address and machine-code columns do not hide control flow', () => {
	const result = new MsvcAssemblyCfgParser().parse(
		assemblyLines([
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
		]),
	);

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
	const result = new MsvcAssemblyCfgParser().parse(
		assemblyLines(['; Function compile flags: /Odtp', 'final_linear PROC', '\tnop', 'final_linear ENDP']),
	);

	assert.deepEqual(result.diagnostics, []);
	assert.deepEqual(result.graphs[0].edges, []);
});

test('an unresolvable jump is reported instead of producing an edge to a missing block', () => {
	// A switch jump table reaches its targets through a table load, and a label
	// that is defined in another function is not a block here either. Upstream
	// stringifies the failed match and emits an edge to a node called `null:`,
	// which makes the whole graph unusable.
	const jumpTableTarget = '$LN9@dispatch[rax*8]';
	const indirect = new MsvcAssemblyCfgParser().parse(
		assemblyLines([
			'; Function compile flags: /Odtp',
			'dispatch PROC',
			'\tmov\teax, DWORD PTR value$[rsp]',
			`\tjmp\tQWORD PTR ${jumpTableTarget}`,
			'$LN2@dispatch:',
			'\tret\t0',
			'dispatch ENDP',
		]),
	);
	assert.equal(indirect.graphs.length, 1);
	assert.deepEqual(indirect.graphs[0].edges, []);
	assert.equal(indirect.diagnostics.length, 1);
	// The diagnostic names the target that could not be resolved.
	assert.ok(indirect.diagnostics[0].includes(jumpTableTarget));
	// The graph is still well formed, so it is not discarded downstream.
	assert.equal(validateControlFlowGraphs(indirect.graphs).graphs.length, 1);

	const broken = new MsvcAssemblyCfgParser().parse(
		assemblyLines(['broken PROC', '\tjmp\t$LNmissing@broken', 'broken ENDP', 'good PROC', '\tret\t0', 'good ENDP']),
	);
	assert.deepEqual(
		broken.graphs.map((graph) => graph.label),
		['broken', 'good'],
	);
	assert.equal(broken.graphs[0].edges.length, 0);
	assert.equal(broken.diagnostics.length, 1);
});

test('clang assembly splits blocks at LBB labels and types every edge', () => {
	const result = new ClangAssemblyCfgParser(new InstructionSetInfo()).parse(
		assemblyLines([
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
		]),
	);

	assert.deepEqual(result.diagnostics, []);
	assert.equal(result.graphs.length, 1);
	const [graph] = result.graphs;
	assert.equal(graph.id, 'clang-asm:classify');
	assert.deepEqual(
		graph.nodes.map((node) => node.id),
		['classify', 'classify@4', '.LBB0_2:', '.LBB0_3:'],
	);
	assert.deepEqual(
		graph.edges.map((edge) => edge.kind),
		['true', 'false', 'unconditional', 'fallthrough'],
	);
	// A tab-indented `retq` is a return; upstream's `' ret'` substring test is not.
	assert.equal(graph.nodes.at(-1)?.terminal, 'return');
	// Directives and CFI pseudo-instructions never reach a node.
	assert.ok(!graph.nodes.some((node) => node.label.includes('.cfi_startproc')));
});

test('the GCC dialect keeps only labels that own an instruction', () => {
	const result = new GccAssemblyCfgParser(new InstructionSetInfo()).parse(
		assemblyLines([
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
		]),
	);

	assert.deepEqual(result.diagnostics, []);
	const [graph] = result.graphs;
	// `.L0` owns only a directive, so it never becomes a block.
	assert.deepEqual(
		graph.nodes.map((node) => node.id),
		['classify()', '.L1:', '.L2:'],
	);
	assert.deepEqual(graph.edges, [
		{ from: 'classify()', to: '.L2:', kind: 'true' },
		{ from: 'classify()', to: '.L1:', kind: 'false' },
	]);
	assert.deepEqual(
		graph.nodes.map((node) => node.terminal),
		[undefined, 'return', 'return'],
	);
});

test('instruction classification distinguishes the dialects it is asked about', () => {
	const base = new InstructionSetInfo();
	assert.deepEqual(
		['\tjmp\t.L4', '\tjle\t.L4', '\tretq', '\trep ret', '\tmovl\t%eax, %ebx'].map((text) => base.classify(text)),
		['unconditional-jump', 'conditional-jump', 'return', 'return', 'linear'],
	);

	const msvc = new MsvcInstructionSetInfo();
	assert.deepEqual(
		[
			'\tjmp\tSHORT $LN3@f',
			'\tjle\tSHORT $LN2@f',
			'\tret\t0',
			'  0004a\teb 0a\t\t jmp\t SHORT $LN3@f',
			'\t00\t\t jge\t $LN2@f',
			'  0004e\tc3\t\t ret\t 0',
			// `jmp` appears inside no other MSVC mnemonic, but `mov` must not be a jump.
			'\tmov\teax, DWORD PTR value$[rsp]',
		].map((text) => msvc.classify(text)),
		[
			'unconditional-jump',
			'conditional-jump',
			'return',
			'unconditional-jump',
			'conditional-jump',
			'return',
			'linear',
		],
	);

	const arm = new ArmInstructionSetInfo();
	assert.deepEqual(
		// `bl` is a call, not a branch out of the block.
		['\tb\t.LBB0_2', '\tb.le\t.LBB0_2', '\tret', '\tbl\tprintf'].map((text) => arm.classify(text)),
		['unconditional-jump', 'conditional-jump', 'return', 'linear'],
	);
});
