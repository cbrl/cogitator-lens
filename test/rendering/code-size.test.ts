import assert from 'node:assert/strict';
import test from 'node:test';
import { renderCodeSize } from '../../src/artifacts/code-size/code-size-renderer.js';
import {
	imageSections,
	parseDumpbinSections,
	parseObjdumpSections,
} from '../../src/artifacts/code-size/object-sections.js';
import { defaultArtifactOptions } from '../../src/types/index.js';
import { rawArtifact, renderContext } from '../support/artifacts.js';
import { readFixture } from '../support/environment.js';

/** `llvm-objdump -h` of a clang-cl object, from LLVM 22.1.3: one `.text` section for each function. */
const llvmObjdumpCoff = [
	'leaf.obj:\tfile format coff-x86-64',
	'',
	'Sections:',
	'Idx Name           Size     VMA              Type',
	'  0 .text          00000000 0000000000000000 TEXT',
	'  1 .data          00000000 0000000000000000 DATA',
	'  2 .bss           00000000 0000000000000000 BSS',
	'  3 .text          00000004 0000000000000000 TEXT',
	'  4 .text          00000010 0000000000000000 TEXT',
	'  5 .text$unlikely 00000002 0000000000000000 TEXT',
	'  6 .text          0000000a 0000000000000000 TEXT',
	'  7 .drectve       00000030 0000000000000000 ',
	'  8 .debug$S       00000098 0000000000000000 DATA, DEBUG',
	'  9 .llvm_addrsig  00000000 0000000000000000 ',
	' 10 .xdata         00000008 0000000000000000 DATA',
	' 11 .pdata         0000000c 0000000000000000 DATA',
].join('\n');

/** `objdump -h` of an ELF object, in the form of GNU binutils. */
const gnuObjdumpElf = [
	'main.o:     file format elf64-x86-64',
	'',
	'Sections:',
	'Idx Name          Size      VMA               LMA               File off  Algn',
	'  0 .text         00000035  0000000000000000  0000000000000000  00000040  2**4',
	'                  CONTENTS, ALLOC, LOAD, READONLY, CODE',
	'  1 .data         00000004  0000000000000000  0000000000000000  00000078  2**2',
	'                  CONTENTS, ALLOC, LOAD, DATA',
	'  2 .bss          00000000  0000000000000000  0000000000000000  0000007c  2**0',
	'                  ALLOC',
	'  3 .comment      0000002c  0000000000000000  0000000000000000  0000007c  2**0',
	'                  CONTENTS, READONLY',
	'  4 .eh_frame     00000048  0000000000000000  0000000000000000  000000a8  2**3',
	'                  CONTENTS, ALLOC, LOAD, RELOC, READONLY, DATA',
].join('\n');

test('the section listings of objdump, llvm-objdump, and dumpbin give the size of each section', () => {
	assert.deepEqual(parseObjdumpSections(gnuObjdumpElf), [
		{ name: '.text', size: 0x35 },
		{ name: '.data', size: 4 },
		{ name: '.bss', size: 0 },
		{ name: '.comment', size: 0x2c },
		{ name: '.eh_frame', size: 0x48 },
	]);
	// The empty first section of an ELF object has no name in llvm-objdump output.
	assert.deepEqual(parseObjdumpSections('  0                 00000000 0000000000000000 \n'), []);
	const dumpbin = [
		'SECTION HEADER #1',
		'   .text$mn name',
		'       0 physical address',
		'       0 virtual address',
		'      2F size of raw data',
		'SECTION HEADER #2',
		'   .debug$S name',
		'       0 physical address',
		'       0 virtual address',
		'      98 size of raw data',
	].join('\n');
	assert.deepEqual(parseDumpbinSections(dumpbin), [
		{ name: '.text$mn', size: 0x2f },
		{ name: '.debug$S', size: 0x98 },
	]);
});

test('the image sections merge the sections of each function and leave out metadata', () => {
	assert.deepEqual(imageSections(parseObjdumpSections(llvmObjdumpCoff)), [
		{ name: '.text', size: 4 + 16 + 2 + 10 },
		{ name: '.pdata', size: 12 },
		{ name: '.xdata', size: 8 },
	]);
	assert.deepEqual(imageSections(parseObjdumpSections(gnuObjdumpElf)), [
		{ name: '.eh_frame', size: 0x48 },
		{ name: '.text', size: 0x35 },
		{ name: '.data', size: 4 },
	]);
	// With -ffunction-sections and -fdata-sections, and in rustc output, each function and variable
	// has a section of its own. GNU ld merges them as its default linker script does.
	const sections = (entries: readonly (readonly [string, number])[]) =>
		imageSections(entries.map(([name, size]) => ({ name, size })));
	assert.deepEqual(
		sections([
			['.text', 0],
			['.text._Z3fooi', 0x10],
			['.text._ZN3app8geometry5total17h0123456789abcdefE', 0x20],
			['.text.unlikely', 4],
			['.text.startup.main', 8],
			['.rela.text._Z3fooi', 0x18],
			['.rodata.str1.1', 6],
			['.rodata..L__unnamed_1', 2],
			['.data.rel.ro..L__unnamed_2', 0x10],
			['.data.rel.ro.local._ZTV3Foo', 8],
			['.data.rel.local.pointer', 8],
			['.bss.counter', 4],
			['.tbss.value', 4],
			['.init_array.00099', 8],
			['.eh_frame', 0x30],
		]),
		[
			{ name: '.text', size: 0x10 + 0x20 + 4 + 8 },
			{ name: '.eh_frame', size: 0x30 },
			{ name: '.data.rel.ro', size: 0x18 },
			{ name: '.data', size: 8 },
			{ name: '.init_array', size: 8 },
			{ name: '.rodata', size: 8 },
			{ name: '.bss', size: 4 },
			{ name: '.tbss', size: 4 },
		],
	);
});

function renderSize(producerData?: unknown, fixture = 'gnu-objdump.txt') {
	const text = readFixture('binary', fixture);
	const projectRoot = process.platform === 'win32' ? 'C:/project' : '/project';
	return renderCodeSize(
		rawArtifact('code-size', process.platform === 'win32' ? text : text.replaceAll('C:/project', '/project'), {
			...(producerData === undefined ? {} : { producerData }),
			command: { executable: process.execPath, args: [], environmentVariableNames: [], cwd: process.cwd() },
		}),
		defaultArtifactOptions.display,
		renderContext('gcc', { file: `${projectRoot}/source.cpp` }),
	);
}

test('the code size lists each function by the bytes of its instructions, largest first', () => {
	const rendered = renderSize({ sections: parseObjdumpSections(gnuObjdumpElf) });
	const text = rendered.lines.map((line) => line.text);
	assert.equal(text[0], '; Code size of source.cpp: 2 functions, 11 bytes of instructions.');
	assert.deepEqual(text.slice(3, 6), [
		'; Bytes   Share  Function',
		'      7   63.6%  main',
		'      4   36.4%  helper',
	]);
	assert.deepEqual(text.slice(7), ['; Bytes  Section', '     72  .eh_frame', '     53  .text', '      4  .data']);
	// Each function row maps to the first source line of its function.
	assert.deepEqual(
		rendered.lines.slice(4, 6).map((line) => line.source?.line),
		[7, 3],
	);
	assert.deepEqual(
		rendered.symbols.map((symbol) => [symbol.name, symbol.line]),
		[
			['main', 4],
			['helper', 5],
		],
	);
	assert.deepEqual(rendered.metrics, { functionCount: 2, codeSizeBytes: 11, sectionBytes: 129 });
});

test('an AArch64 instruction word of GNU objdump is four bytes', () => {
	// GNU objdump 2.46 of clang 20.1 --target=aarch64-linux-gnu -O1: twice has 2 instructions, and sum has 12.
	const rendered = renderSize(undefined, 'gnu-objdump-aarch64.txt');
	assert.deepEqual(
		rendered.lines.slice(4, 6).map((line) => line.text),
		['     48   85.7%  sum', '      8   14.3%  twice'],
	);
	assert.equal(rendered.metrics.codeSizeBytes, 56);
});

test('the code size without a section listing shows the functions only', () => {
	const rendered = renderSize();
	assert.equal(
		rendered.lines.some((line) => line.text.includes('Section')),
		false,
	);
	assert.equal(rendered.metrics.sectionBytes, undefined);
});
