import assert from 'node:assert/strict';
import test from 'node:test';
import { artifactDefinitions } from '../../src/artifacts/core/artifact-definitions.js';
import {
	normalizeDisassemblySourcePaths,
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
		['done', 'helper'],
		'A link covers its label exactly',
	);
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
