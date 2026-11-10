import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { markAnalysisRegions } from '../../src/artifacts/machine-code-analysis/analysis-regions.js';
import { analysisProcessor } from '../../src/artifacts/machine-code-analysis/analysis-producer.js';
import { renderMachineCodeAnalysis } from '../../src/artifacts/machine-code-analysis/analysis-renderer.js';
import { resolveCompilerPath } from '../../src/file-identity.js';
import { defaultArtifactOptions } from '../../src/types/index.js';
import { rawArtifact, renderContext } from '../support/artifacts.js';

/** ELF assembly in the form of clang 21 with `-gline-tables-only`: two functions and a variable. */
const elfAssembly = [
	'\t.file\t"main.c"',
	'\t.text',
	'\t.globl\tsquare',
	'\t.type\tsquare,@function',
	'square:',
	'.Lfunc_begin0:',
	'\t.file\t0 "/project" "main.c" md5 0x0123',
	'\t.loc\t0 1 0',
	'\t.cfi_startproc',
	'# %bb.0:',
	'\t.loc\t0 1 30 prologue_end',
	'\tmovl\t%edi, %eax',
	'\timull\t%edi, %eax',
	'\t.loc\t0 2 1',
	'\tretq',
	'.Lfunc_end0:',
	'\t.size\tsquare, .Lfunc_end0-square',
	'\t.cfi_endproc',
	'                                        # -- End function',
	'\t.globl\tlooped',
	'\t.type\tlooped,@function',
	'looped:',
	'\t.cfi_startproc',
	'\t.loc\t0 4 3',
	'\txorl\t%eax, %eax',
	'.LBB1_1:',
	'\t.loc\t0 0 3',
	'\taddl\t%edi, %eax',
	'\tjne\t.LBB1_1',
	'\tretq',
	'.Lfunc_end1:',
	'\t.cfi_endproc',
	'\t.type\tcounter,@object',
	'\t.data',
	'counter:',
	'\t.long\t3',
].join('\n');

test('each function of ELF assembly becomes a code region with the source of each instruction', () => {
	const marked = markAnalysisRegions(elfAssembly, 'x86');
	assert.deepEqual(
		marked.regions.map((region) => region.name),
		['square', 'looped'],
	);
	assert.deepEqual(marked.regions[0].sources, [
		{ file: '/project/main.c', line: 1 },
		{ file: '/project/main.c', line: 1 },
		{ file: '/project/main.c', line: 2 },
	]);
	// Line 0 is compiler-made code without a source line.
	assert.deepEqual(marked.regions[1].sources, [{ file: '/project/main.c', line: 4 }, null, null, null]);

	const lines = marked.text.split('\n');
	const begin = lines.indexOf('# LLVM-MCA-BEGIN square');
	const end = lines.indexOf('# LLVM-MCA-END square');
	assert.deepEqual(
		lines.slice(begin + 1, end).filter((line) => !line.startsWith('.')),
		['\tmovl\t%edi, %eax', '\timull\t%edi, %eax', '\tretq'],
	);
	assert.ok(lines.indexOf('# LLVM-MCA-BEGIN looped') > end);
	assert.equal(
		lines.some((line) => /^\s*\.(?:loc|file)\b/u.test(line)),
		false,
		'llvm-mca does not get the debug line directives',
	);
	assert.equal(lines.filter((line) => line.includes('LLVM-MCA-BEGIN')).length, 2, 'A variable is no region');
});

test('the code after a GCC jump table stays in its function, and a cold part is a region of its own', () => {
	// GCC 15 -O2 writes the jump table of a switch into .rodata, and the cases follow it in .text.
	const gcc = [
		'\t.text',
		'\t.globl\tdense',
		'\t.type\tdense, @function',
		'dense:',
		'.LFB1:',
		'\t.cfi_startproc',
		'\tcmpl\t$5, %edi',
		'\tja\t.L14',
		'\tleaq\t.L8(%rip), %rax',
		'\tmovslq\t(%rax,%rdi,4), %rdx',
		'\taddq\t%rax, %rdx',
		'\tnotrack jmp\t*%rdx',
		'\t.section\t.rodata',
		'\t.align 4',
		'.L8:',
		'\t.long\t.L13-.L8',
		'\t.long\t.L10-.L8',
		'\t.text',
		'\t.p2align 4,,10',
		'.L13:',
		'\tleal\t(%rsi,%rsi,2), %eax',
		'\tret',
		'.L10:',
		'\tmovl\t%esi, %eax',
		'\txorl\t$5, %eax',
		'\tret',
		'\t.cfi_endproc',
		'\t.section\t.text.unlikely',
		'\t.cfi_startproc',
		'\t.type\tdense.cold, @function',
		'dense.cold:',
		'.L14:',
		'\tmovl\t%esi, %eax',
		'\tret',
		'\t.cfi_endproc',
		'\t.text',
		'\t.size\tdense, .-dense',
		'\t.section\t.text.unlikely',
		'\t.size\tdense.cold, .-dense.cold',
		'\t.section\t.rodata',
		'CSWTCH.1:',
		'\t.long\t11',
	].join('\n');
	const marked = markAnalysisRegions(gcc, 'x86');
	assert.deepEqual(
		marked.regions.map((region) => [region.name, region.sources.length]),
		[
			['dense', 11],
			['dense.cold', 2],
		],
	);
	const lines = marked.text.split('\n');
	assert.ok(lines.indexOf('# LLVM-MCA-END dense') > lines.indexOf('\txorl\t$5, %eax'));
});

test('COFF functions are regions, also without unwind information, and CodeView gives their sources', () => {
	const clangCl = [
		'\t.def\t"?leaf@@YAHH@Z";',
		'\t.scl\t2;',
		'\t.type\t32;',
		'\t.endef',
		'\t.cv_file\t1 "C:\\\\project\\\\leaf.cpp" "0123" 1',
		'"?leaf@@YAHH@Z":                        # @"?leaf@@YAHH@Z"',
		'\t.cv_loc\t0 1 1 0',
		'\tleal\t(%rcx,%rcx,2), %eax',
		'\tretq',
		'\t.def\t@feat.00;',
		'\t.scl\t3;',
		'\t.type\t0;',
		'\t.endef',
	].join('\n');
	const marked = markAnalysisRegions(clangCl, 'x86');
	assert.deepEqual(marked.regions, [
		{
			name: '?leaf@@YAHH@Z',
			sources: [
				{ file: 'C:\\project\\leaf.cpp', line: 1 },
				{ file: 'C:\\project\\leaf.cpp', line: 1 },
			],
		},
	]);

	// MinGW GCC writes the whole definition on one line.
	const mingw = ['\t.def\tmain;\t.scl\t2;\t.type\t32;\t.endef', 'main:', '\txorl\t%eax, %eax', '\tret'].join('\n');
	assert.deepEqual(
		markAnalysisRegions(mingw, 'x86').regions.map((region) => [region.name, region.sources.length]),
		[['main', 2]],
	);
});

test('Mach-O functions start before their unwind directive, and AArch64 markers use its comment', () => {
	const macho = [
		'\t.globl\t_twice',
		'\t.p2align\t2',
		'_twice:',
		'\t.cfi_startproc',
		'\tlsl\tw0, w0, #1',
		'\tret',
		'\t.cfi_endproc',
		'ltmp0:',
	].join('\n');
	const marked = markAnalysisRegions(macho, 'aarch64');
	assert.deepEqual(
		marked.regions.map((region) => [region.name, region.sources.length]),
		[['_twice', 2]],
	);
	assert.ok(marked.text.includes('// LLVM-MCA-BEGIN _twice'));
	assert.ok(marked.text.includes('// LLVM-MCA-END _twice'));
});

test('the processor comes from the last processor argument, and generic is the default', () => {
	assert.equal(analysisProcessor([], 'x86'), 'generic');
	assert.equal(analysisProcessor(['-O2', '-march=skylake', '-mcpu=znver4'], 'x86'), 'znver4');
	assert.equal(analysisProcessor(['-march=haswell'], 'x86'), 'haswell');
	// On AArch64, -march names an architecture version, not a processor.
	assert.equal(analysisProcessor(['-march=armv8.2-a'], 'aarch64'), 'generic');
	assert.equal(analysisProcessor(['/clang:-march=icelake-server'], 'x86'), 'icelake-server');
	assert.equal(analysisProcessor(['-C', 'target-cpu=native'], 'x86'), 'native');
	assert.equal(analysisProcessor(['-Ctarget-cpu=apple-m1'], 'aarch64'), 'apple-m1');
});

/** A report in the form of llvm-mca 21, with the two tables that list each instruction. */
function report(regions: readonly { readonly name: string; readonly instructions: readonly string[] }[]): string {
	return regions
		.flatMap(({ name, instructions }, index) => [
			`[${index}] Code Region - ${name}`,
			'',
			'Iterations:        100',
			`Instructions:      ${instructions.length * 100}`,
			'',
			'Instruction Info:',
			'[1]: #uOps',
			'',
			'[1]    [2]    [3]    [4]    [5]    [6]    Instructions:',
			...instructions.map((instruction) => ` 1      1     0.33                        ${instruction}`),
			'',
			'Resource pressure by instruction:',
			'[0]    [1]    [2]    Instructions:',
			...instructions.map((instruction) => ` -     0.33   0.33   ${instruction}`),
			'',
			'',
		])
		.join('\n');
}

test('the rows of each instruction table map to the source lines of their instructions', () => {
	const marked = markAnalysisRegions(elfAssembly, 'x86');
	const raw = rawArtifact(
		'machine-code-analysis',
		report([
			{ name: 'square', instructions: ['movl\t%edi, %eax', 'imull\t%edi, %eax', 'retq'] },
			// llvm-mca skipped an instruction of this region, so its rows do not map.
			{ name: 'looped', instructions: ['xorl\t%eax, %eax', 'addl\t%edi, %eax', 'retq'] },
		]),
		{ producerData: { regions: marked.regions } },
	);
	const rendered = renderMachineCodeAnalysis(raw, defaultArtifactOptions.display, renderContext('clang'));
	const mapped = rendered.lines.flatMap((line, index) => (line.source ? [[index, line.source.line]] : []));
	const file = resolveCompilerPath('/project/main.c', path.resolve('/project'));
	assert.deepEqual(
		rendered.lines.filter((line) => line.source).map((line) => line.source?.file),
		Array(6).fill(file),
	);
	assert.deepEqual(
		mapped.map(([, line]) => line),
		[1, 1, 2, 1, 1, 2],
		'Both tables of the first region map, and the second region has no mapping',
	);
	assert.deepEqual(
		rendered.symbols.map((symbol) => [symbol.name, rendered.lines[symbol.line].text]),
		[
			['square', '[0] Code Region - square'],
			['looped', '[1] Code Region - looped'],
		],
	);
	assert.deepEqual(
		rendered.folds.map((fold) => fold.startLine),
		rendered.symbols.map((symbol) => symbol.line),
	);
	assert.deepEqual(rendered.metrics, { regionCount: 2, mappedRowCount: 6 });
});

test('a report without producer data shows the text without a mapping', () => {
	const rendered = renderMachineCodeAnalysis(
		rawArtifact('machine-code-analysis', report([{ name: 'f', instructions: ['retq'] }])),
		defaultArtifactOptions.display,
		renderContext('clang'),
	);
	assert.equal(
		rendered.lines.some((line) => line.source),
		false,
	);
	assert.equal(rendered.symbols.length, 1);
});
