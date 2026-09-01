import assert from 'node:assert/strict';
import test from 'node:test';
import { artifactDefinitions } from '../../src/artifacts/core/artifact-definitions.js';
import {
	normalizeDisassemblySourcePaths,
	normalizeDumpbinOutput,
} from '../../src/artifacts/binary-disassembly/binary-disassembly-producer.js';
import { defaultArtifactOptions, type ToolchainKind } from '../../src/types/index.js';
import { rawArtifact, renderContext } from '../support/artifacts.js';
import { readFixture } from '../support/environment.js';

const display = defaultArtifactOptions.display;

/** Fixtures are recorded on Windows; a POSIX host reads the same listing with POSIX paths. */
function platformFixture(...segments: readonly string[]): string {
	const text = readFixture(...segments);
	return process.platform === 'win32' ? text : text.replaceAll('C:/project', '/project');
}

function renderDisassembly(kind: ToolchainKind, text: string) {
	return artifactDefinitions['binary-disassembly'].renderer(
		rawArtifact('binary-disassembly', text, {
			command: {
				executable: process.execPath,
				arguments: [],
				environmentVariableNames: [],
				workingDirectory: process.cwd(),
			},
		}),
		display,
		renderContext(kind, { file: '/project/source.cpp' }),
	);
}

test('GNU disassembly renders addresses, bytes, links, source mappings, symbols, and size', () => {
	const rendered = renderDisassembly('gcc', platformFixture('binary', 'gnu-objdump.txt'));

	assert.ok(
		rendered.lines.some(
			(line) => line.address === 1 && line.opcodes?.length === 5 && line.disassembly?.includes('call'),
		),
	);
	assert.ok(rendered.sourceLocations.some((location) => location.sourceLine === 7));
	assert.ok(rendered.links.some((link) => link.targetLine >= 0));
	assert.ok(
		rendered.links.every((link) => link.edgeKind === undefined),
		'calls must not be drawn as jump edges',
	);
	assert.ok(rendered.symbols.some((symbol) => symbol.name === 'helper'));
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
	assert.ok(rendered.sourceLocations.some((location) => location.sourceLine === 3));
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
