import assert from 'node:assert/strict';
import test from 'node:test';
import { artifactDefinitions } from '../../src/artifacts/core/artifact-definitions.js';
import { normalizeDisassemblySourcePaths } from '../../src/artifacts/binary-disassembly/binary-disassembly-producer.js';
import { normalizeDumpbinOutput } from '../../src/toolchains/msvc.js';
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
	const normalized = normalizeDumpbinOutput(platformFixture('binary', 'dumpbin.txt'));
	assert.match(normalized, /0 <\?helper@@YAHH@Z>:/);
	assert.match(normalized, /0: 55\s+push/);
	assert.match(normalized, /9 <\?entry@@YAHH@Z>:/);
	assert.match(normalized, /call\s+0+ <\?helper@@YAHH@Z>/);
	assert.equal(normalizeDisassemblySourcePaths('c:\\project path\\source.cpp:12'), 'C:/project path/source.cpp:12');

	const rendered = renderDisassembly('msvc', normalized);
	assert.ok(rendered.lines.some((line) => line.address === 9 && line.opcodes?.length === 3));
	assert.ok(rendered.lines.some((line) => Boolean(line.source?.file) && line.source?.line === 3));
	assert.ok(rendered.links.some((link) => link.targetLine >= 0));
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
