import assert from 'node:assert/strict';
import test from 'node:test';
import { artifactDefinitions } from '../../src/artifacts/core/artifact-definitions.js';
import {
	normalizeDisassemblySourcePaths,
	normalizeLlvmObjdumpOutput,
	withoutLineMarkerComments,
} from '../../src/artifacts/binary-disassembly/binary-disassembly-producer.js';
import { normalizeDumpbinOutput } from '../../src/toolchains/msvc.js';
import { withCodeViewSourceLines } from '../../src/toolchains/msvc/codeview-lines.js';
import { defaultArtifactOptions, type DisplayOptions, type ToolchainKind } from '../../src/types/index.js';
import { rawArtifact, renderContext } from '../support/artifacts.js';
import { readFixture } from '../support/environment.js';

const display = defaultArtifactOptions.display;

/** Fixtures are recorded on Windows; a POSIX host reads the same listing with POSIX paths. */
function platformFixture(...segments: readonly string[]): string {
	const text = readFixture(...segments);
	return process.platform === 'win32' ? text : text.replaceAll('C:/project', '/project');
}

function renderDisassembly(kind: ToolchainKind, text: string, options: Partial<DisplayOptions> = {}) {
	return artifactDefinitions['binary-disassembly'].renderer(
		rawArtifact('binary-disassembly', text, {
			command: {
				executable: process.execPath,
				args: [],
				environmentVariableNames: [],
				cwd: process.cwd(),
			},
		}),
		{ ...display, ...options },
		renderContext(kind, { file: `${projectRoot}/source.cpp` }),
	);
}

const projectRoot = process.platform === 'win32' ? 'C:/project' : '/project';

test('GNU disassembly renders addresses, bytes, links, source mappings, symbols, and size', () => {
	const rendered = renderDisassembly('gcc', platformFixture('binary', 'gnu-objdump.txt'));

	assert.ok(
		rendered.lines.some(
			(line) => line.address === 1 && line.opcodes?.length === 5 && line.disassembly?.includes('call'),
		),
	);
	assert.ok(rendered.lines.some((line) => Boolean(line.source?.file) && line.source?.line === 7));
	const helper = rendered.lines.findIndex((line) => line.text.trim() === 'helper:');
	const call = rendered.lines.findIndex((line) => line.disassembly?.includes('call'));
	assert.equal(
		rendered.links.find((link) => link.line === call)?.targetLine,
		helper,
		'A call links to the label line of its target',
	);
	assert.ok(
		rendered.links.every((link) => link.edgeKind === undefined),
		'calls must not be drawn as jump edges',
	);
	assert.equal(rendered.symbols.find((symbol) => symbol.name === 'helper')?.line, helper);
	assert.ok(rendered.folds.some((fold) => fold.endLine > fold.startLine));
	assert.deepEqual([rendered.metrics.codeSizeBytes, rendered.metrics.instructionCount], [11, 5]);
});

test('dumpbin output is adapted before reusing the common raw-assembly parser', () => {
	// dumpbin prints no line numbers for an object, so the lines come from its CodeView line table.
	const lines = (entries: readonly (readonly [number, number])[]) =>
		entries.map(([offset, line]) => ({ offset, file: `${projectRoot}/source.cpp`, line }));
	const table = new Map([
		[
			'?helper@@YAHH@Z',
			lines([
				[0, 1],
				[4, 2],
				[10, 3],
			]),
		],
		[
			'?entry@@YAHH@Z',
			lines([
				[32, 5],
				[40, 6],
				[51, 7],
			]),
		],
	]);
	const normalized = withCodeViewSourceLines(normalizeDumpbinOutput(readFixture('binary', 'dumpbin.txt')), table);
	assert.match(normalized, /0 <\?helper@@YAHH@Z>:/);
	assert.match(normalized, /0: 89 4c 24 08\s+mov/);
	assert.match(normalized, /20 <\?entry@@YAHH@Z>:/);
	assert.match(normalized, /call\s+0+ <\?helper@@YAHH@Z>/);
	assert.equal(normalizeDisassemblySourcePaths('c:\\project path\\source.cpp:12'), 'C:/project path/source.cpp:12');

	const rendered = renderDisassembly('msvc', normalized);
	const sourceLine = (address: number) => rendered.lines.find((line) => line.address === address)?.source?.line;
	assert.ok(rendered.lines.some((line) => line.address === 0x2c && line.opcodes?.length === 5));
	assert.deepEqual(
		[sourceLine(0), sourceLine(0xa), sourceLine(0x20), sourceLine(0x2c), sourceLine(0x37)],
		[1, 3, 5, 6, 7],
	);
	assert.ok(rendered.links.some((link) => link.targetLine >= 0));
});

test('dumpbin headings keep the symbol of a member function, whose demangled name holds colons', () => {
	const normalized = normalizeDumpbinOutput(
		[
			'?fov_y@camera@re@@QEBAMXZ (public: float __cdecl re::camera::fov_y(void)const ):',
			'  0000000000000060: 48 89 4C 24 08     mov         qword ptr [rsp+8],rcx',
		].join('\r\n'),
	);
	assert.deepEqual(normalized.split('\n'), [
		'0000000000000060 <?fov_y@camera@re@@QEBAMXZ>:',
		'0000000000000060: 48 89 4c 24 08     mov         qword ptr [rsp+8],rcx',
	]);
});

test('label navigation marks only CFG-classified jumps as drawable edges', () => {
	const rendered = renderDisassembly(
		'gcc',
		[
			'0000000000000000 <main>:',
			'   0: 75 02                 jne    4 <done>',
			'   2: e8 02 00 00 00        call   9 <helper>',
			'0000000000000004 <done>:',
			'   4: c3                    ret',
			'0000000000000009 <helper>:',
			'   9: c3                    ret',
		].join('\n'),
	);
	assert.equal(rendered.links.find((link) => rendered.lines[link.line].text.includes('jne'))?.edgeKind, 'true');
	assert.equal(rendered.links.find((link) => rendered.lines[link.line].text.includes('call'))?.edgeKind, undefined);
	assert.deepEqual(
		rendered.links.map((link) => rendered.lines[link.line].text.slice(link.startCharacter, link.endCharacter)),
		['4 <done>', '9 <helper>'],
		'A link covers the target operand',
	);
});

/** The text of each link and the text of its target line. */
function branchLinks(rendered: ReturnType<typeof renderDisassembly>): [string, string][] {
	return rendered.links.map((link) => [
		rendered.lines[link.line].text.slice(link.startCharacter, link.endCharacter),
		rendered.lines[link.targetLine].text.trim(),
	]);
}

test('GNU objdump jumps link to their target instruction, and calls to the function of their relocation', () => {
	// objdump -d -l -w -r of a g++ -O0 object. The call holds no target until it is linked.
	const rendered = renderDisassembly(
		'gcc',
		[
			'0000000000000000 <_Z6helperi>:',
			'_Z6helperi():',
			`${projectRoot}/source.cpp:1`,
			'   0:\tf3 0f 1e fa          \tendbr64',
			'  11:\tc3                   \tret',
			'0000000000000012 <_Z5counti>:',
			'_Z5counti():',
			`${projectRoot}/source.cpp:7`,
			'  2f:\teb 3d                \tjmp    6e <_Z5counti+0x5c>',
			`${projectRoot}/source.cpp:8`,
			'  31:\t8b 4d fc             \tmov    -0x4(%rbp),%ecx',
			'  58:\t74 0f                \tje     69 <_Z5counti+0x57>',
			`${projectRoot}/source.cpp:11`,
			'  5f:\te8 00 00 00 00       \tcall   64 <_Z5counti+0x52>\t60: R_X86_64_PLT32\t_Z6helperi-0x4',
			'  64:\t01 45 f8             \tadd    %eax,-0x8(%rbp)',
			`${projectRoot}/source.cpp:9`,
			'  69:\t90                   \tnop',
			`${projectRoot}/source.cpp:7`,
			'  6e:\t8b 45 fc             \tmov    -0x4(%rbp),%eax',
			'  74:\t7c bb                \tjl     31 <_Z5counti+0x1f>',
			'  7a:\tc3                   \tret',
		].join('\n'),
	);
	assert.deepEqual(branchLinks(rendered), [
		['6e <_Z5counti+0x5c>', 'mov    -0x4(%rbp),%eax'],
		['69 <_Z5counti+0x57>', 'nop'],
		['_Z6helperi', '_Z6helperi:'],
		['31 <_Z5counti+0x1f>', 'mov    -0x4(%rbp),%ecx'],
	]);
	assert.deepEqual(
		rendered.links.map((link) => link.edgeKind),
		['unconditional', 'true', undefined, 'true'],
	);
});

test('llvm-objdump branches link for ELF and COFF objects, with each relocation on its instruction line', () => {
	// llvm-objdump --disassemble --line-numbers --reloc of a clang and a clang-cl -O0 object.
	const listing = (helper: string, count: string, relocation: string) =>
		normalizeLlvmObjdumpOutput(
			[
				`0000000000000000 <${helper}>:`,
				`; ${helper}():`,
				`; ${projectRoot}/source.cpp:1`,
				'       0: 89 7d fc                     \tmovl\t%edi, -0x4(%rbp)',
				'       f: c3                           \tretq',
				`0000000000000010 <${count}>:`,
				`; ${count}():`,
				`; ${projectRoot}/source.cpp:7`,
				'      29: 8b 45 f4                     \tmovl\t-0xc(%rbp), %eax',
				`      2f: 7d 2b                        \tjge\t0x5c <${count}+0x4c>`,
				`; ${projectRoot}/source.cpp:11`,
				`      46: e8 00 00 00 00               \tcallq\t0x4b <${count}+0x3b>`,
				`\t\t0000000000000047:  ${relocation}`,
				'      4b: 03 45 f8                     \taddl\t-0x8(%rbp), %eax',
				`      5a: eb cd                        \tjmp\t0x29 <${count}+0x19>`,
				`; ${projectRoot}/source.cpp:13`,
				'      5c: 8b 45 f8                     \tmovl\t-0x8(%rbp), %eax',
				'      64: c3                           \tretq',
			].join('\r\n'),
		);

	const elf = listing('_Z6helperi', '_Z5counti', 'R_X86_64_PLT32\t_Z6helperi-0x4');
	assert.match(elf, /callq\t0x4b <_Z5counti\+0x3b>\t47: R_X86_64_PLT32\t_Z6helperi-0x4\n/);
	assert.deepEqual(branchLinks(renderDisassembly('clang', elf)), [
		['0x5c <_Z5counti+0x4c>', 'movl\t-0x8(%rbp), %eax'],
		['_Z6helperi', '_Z6helperi:'],
		['0x29 <_Z5counti+0x19>', 'movl\t-0xc(%rbp), %eax'],
	]);

	const coff = listing('?helper@@YAHH@Z', '?count@@YAHH@Z', 'IMAGE_REL_AMD64_REL32\t?helper@@YAHH@Z');
	const rendered = renderDisassembly('clang-cl', coff);
	assert.deepEqual(branchLinks(rendered), [
		['0x5c <?count@@YAHH@Z+0x4c>', 'movl\t-0x8(%rbp), %eax'],
		['?helper@@YAHH@Z', '?helper@@YAHH@Z:'],
		['0x29 <?count@@YAHH@Z+0x19>', 'movl\t-0xc(%rbp), %eax'],
	]);
	// The relocation stays visible on its call.
	assert.ok(rendered.lines.some((line) => line.text.includes('IMAGE_REL_AMD64_REL32')));
});

test('dumpbin jumps link to an address in their own function, though each COMDAT function starts at 0', () => {
	const normalized = normalizeDumpbinOutput(
		[
			'?classify@@YAHH@Z (int __cdecl classify(int)):',
			'  0000000000000000: 89 4C 24 08        mov         dword ptr [rsp+8],ecx',
			'  0000000000000004: 83 7C 24 08 0A     cmp         dword ptr [rsp+8],0Ah',
			'  0000000000000009: 7E 06              jle         0000000000000011',
			'  000000000000000B: 8B 44 24 08        mov         eax,dword ptr [rsp+8]',
			'  000000000000000F: EB 06              jmp         0000000000000017',
			'  0000000000000011: 8B 44 24 08        mov         eax,dword ptr [rsp+8]',
			'  0000000000000015: F7 D8              neg         eax',
			'  0000000000000017: C3                 ret',
			'',
			'?loop@@YAXXZ (void __cdecl loop(void)):',
			'  0000000000000000: 48 83 EC 28        sub         rsp,28h',
			'  0000000000000004: E8 00 00 00 00     call        ?classify@@YAHH@Z',
			'  0000000000000009: 85 C0              test        eax,eax',
			'  000000000000000B: 74 F7              je          0000000000000004',
			'  000000000000000D: EB FC              jmp         000000000000000B',
		].join('\r\n'),
	);
	assert.deepEqual(branchLinks(renderDisassembly('msvc', normalized)), [
		['0000000000000011', 'mov         eax,dword ptr [rsp+8]'],
		['0000000000000017', 'ret'],
		['0000000000000000 <?classify@@YAHH@Z>', '?classify@@YAHH@Z:'],
		['0000000000000004', 'call        0000000000000000 <?classify@@YAHH@Z>'],
		// dumpbin writes the address in uppercase.
		['000000000000000b', 'je          0000000000000004'],
	]);
});

test('malformed disassembler output produces a valid empty normalized artifact', () => {
	const rendered = renderDisassembly('gcc', 'not disassembly');
	assert.deepEqual(rendered.lines, []);
	assert.deepEqual([rendered.metrics.codeSizeBytes, rendered.metrics.instructionCount], [0, 0]);
});

test('hiding library code removes functions whose lines all come from headers', () => {
	const listing = [
		'0000000000000000 <_Z6helperi>:',
		'_Z6helperi():',
		`${projectRoot}/helper.h:1`,
		'   0:\t8d 04 3f             \tlea    (%rdi,%rdi,1),%eax',
		'   3:\tc3                   \tret',
		'0000000000000010 <_Z5counti>:',
		'_Z5counti():',
		`${projectRoot}/source.cpp:2`,
		'  10:\t31 c0                \txor    %eax,%eax',
		// An inlined header line inside a function of the compiled file keeps the function.
		`${projectRoot}/helper.h:1 (discriminator 1)`,
		'  12:\t01 c0                \tadd    %eax,%eax',
		'  14:\tc3                   \tret',
	].join('\n');
	const labels = (options: Partial<DisplayOptions>) =>
		renderDisassembly('gcc', listing, options).symbols.map((symbol) => symbol.name);
	assert.deepEqual(labels({ showLibraryCode: true }), ['_Z6helperi', '_Z5counti']);
	assert.deepEqual(labels({ showLibraryCode: false }), ['_Z5counti']);
	const filtered = renderDisassembly('gcc', listing, { showLibraryCode: false });
	assert.equal(filtered.lines.filter((line) => line.opcodes?.length).length, 3);
});

test('hiding library code keeps functions without line information', () => {
	// dumpbin writes no line numbers for an object file, and llvm-objdump reads none from CodeView.
	const listing = normalizeDumpbinOutput(
		[
			'Dump of file output.obj',
			'',
			'File Type: COFF OBJECT',
			'',
			'?classify@@YAHH@Z (int __cdecl classify(int)):',
			'  0000000000000000: 89 4C 24 08        mov         dword ptr [rsp+8],ecx',
			'  0000000000000004: C3                 ret',
		].join('\r\n'),
	);
	const instructions = (options: Partial<DisplayOptions>) =>
		renderDisassembly('msvc', listing, options).lines.filter((line) => line.opcodes?.length).length;
	assert.equal(instructions({ showLibraryCode: true }), 2);
	assert.equal(instructions({ showLibraryCode: false }), 2);
});

test('llvm-objdump line markers lose their comment prefix so lines map to source', () => {
	assert.equal(
		withoutLineMarkerComments('; /project/a.cpp:3\n; _Z1fv():\n       0: c3   ret\n; C:\\project\\a.cpp:4'),
		'/project/a.cpp:3\n; _Z1fv():\n       0: c3   ret\nC:\\project\\a.cpp:4',
	);
});
