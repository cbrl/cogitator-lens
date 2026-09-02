import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { artifactDefinitions } from '../../src/artifacts/core/artifact-definitions.js';
import { optimizationRemarksRenderer } from '../../src/artifacts/optimization-remarks/optimization-remarks-renderer.js';
import { defaultArtifactOptions } from '../../src/types/index.js';
import { rawArtifact, renderContext } from '../support/artifacts.js';
import { readFixture } from '../support/environment.js';
import { toolchainBackend } from '../support/toolchains.js';

const display = defaultArtifactOptions.display;
const stack = artifactDefinitions['stack-analysis'].renderer;
const remarks = artifactDefinitions['optimization-remarks'].renderer;

test('stack usage becomes per-function annotations, an unmapped section, and frame metrics', () => {
	const source = path.resolve('/project/source.cpp');
	const rendered = stack(
		rawArtifact(
			'stack-analysis',
			[
				`${source}:2:3:first()\t16\tstatic`,
				`${source}:2:7:second()\t32\tdynamic,bounded`,
				`${path.resolve('/project/header.h')}:1:1:header_fn()\t64\tdynamic`,
			].join('\n'),
		),
		display,
		renderContext('gcc', { file: source, text: 'first line\nsecond line\nthird line' }),
	);

	// Each remark gets its own anchor row so two on one source line stay legible.
	assert.deepEqual(
		rendered.lines.slice(0, 4).map((line) => line.text),
		['first line', '', '', 'second line'],
	);
	assert.deepEqual(rendered.lines[1].annotations, [
		{
			kind: 'stack-usage',
			functionName: 'first()',
			value: 16,
			unit: 'bytes',
			qualifier: 'static',
			text: 'stack: 16 bytes, static — first()',
			style: 'stack-usage',
		},
	]);
	assert.deepEqual([rendered.lines[1].source?.column, rendered.lines[2].source?.column], [2, 6]);
	// An entry in another file cannot annotate a source line, so it is listed on
	// its own unmapped row instead of being dropped.
	const unmapped = rendered.lines.filter((line) => line.text.includes('header_fn()'));
	assert.equal(unmapped.length, 1);
	assert.equal(unmapped[0].text, 'stack: 64 bytes, dynamic — header_fn()');
	assert.equal(unmapped[0].source, undefined);
	assert.deepEqual(rendered.metrics, {
		functionCount: 3,
		largestFrame: 64,
		largestFrameUnit: 'bytes',
		totalKnownFrame: 112,
		totalKnownFrameUnit: 'bytes',
		dynamicFrameCount: 2,
		unmappedEntryCount: 1,
	});
});

test('Windows stack paths map to source annotations without losing the drive prefix', (t) => {
	if (process.platform !== 'win32') {
		t.skip('Windows path-to-source comparison is platform-specific');
		return;
	}
	const source = 'C:\\work dir\\source.cpp';
	const rendered = stack(
		rawArtifact('stack-analysis', `${source}:2:1:windows_function()\t40\tstatic`),
		display,
		renderContext('clang-cl', { file: source, text: 'first line\nsecond line' }),
	);

	assert.ok(
		rendered.lines
			.flatMap((line) => line.annotations ?? [])
			.some((item) => item.kind === 'stack-usage' && item.functionName === 'windows_function()'),
	);
	assert.equal(rendered.metrics.unmappedEntryCount, 0);
});

test('Python stack usage keeps VM-slot units explicit through the toolchain renderer', () => {
	const source = path.resolve('/project/source.py');
	const rendered = toolchainBackend('python').renderArtifact(
		rawArtifact(
			'stack-analysis',
			JSON.stringify({
				entries: [
					{ qualifiedName: '<module>', firstLine: 1, stackSize: 2, nesting: [] },
					{ qualifiedName: 'answer', firstLine: 2, stackSize: 7, nesting: [] },
				],
			}),
		),
		display,
		renderContext('python', { file: source, text: 'value = 1\ndef answer():\n    return value' }),
	);

	assert.equal(rendered.presentation, 'text');
	if (rendered.presentation !== 'text') {
		return;
	}
	// Python frames are counted in interpreter stack slots, and the unit travels
	// with every annotation and metric rather than only with the heading text.
	assert.deepEqual(
		rendered.lines
			.flatMap((line) => line.annotations ?? [])
			.find((item) => item.kind === 'stack-usage' && item.functionName === 'answer'),
		{
			kind: 'stack-usage',
			functionName: 'answer',
			value: 7,
			unit: 'vm-slots',
			qualifier: 'vm',
			text: 'stack: 7 VM slots — answer',
			style: 'stack-usage',
		},
	);
	assert.equal(rendered.metrics.largestFrameUnit, 'vm-slots');
	assert.equal(rendered.metrics.totalKnownFrame, 9);
});

test('clang optimization records land on empty anchor rows above their source lines', () => {
	const rendered = remarks(
		rawArtifact('optimization-remarks', readFixture('optimization-remarks', 'clang.opt.yaml')),
		display,
		renderContext('clang', {
			file: path.normalize('/project/source.cpp'),
			text: Array.from({ length: 15 }, (_, index) => `source line ${index + 1}`).join('\n'),
		}),
	);

	assert.equal(rendered.lines.length, 17);
	assert.deepEqual(rendered.lines[7].annotations?.[0], {
		kind: 'optimization-remark',
		category: 'passed',
		message: 'loop-vectorize: vectorized loop (vectorization width: 4)',
		text: '[passed] loop-vectorize: vectorized loop (vectorization width: 4)',
		style: 'optimization-passed',
	});
	assert.deepEqual([rendered.lines[7].source?.line, rendered.lines[7].source?.column], [8, 2]);
	assert.equal(rendered.lines[8].text, 'source line 8');
	assert.equal(rendered.lines[8].annotations, undefined);
	const missed = rendered.lines[14].annotations?.[0];
	assert.equal(missed?.kind, 'optimization-remark');
	assert.match(missed?.kind === 'optimization-remark' ? missed.message : '', /inline: external will not be inlined/);
	assert.equal(rendered.lines[15].text, 'source line 14');
	assert.deepEqual(
		[rendered.metrics.remarkCount, rendered.metrics.omittedRemarkCount, rendered.metrics.passedRemarkCount],
		[2, 0, 1],
	);
	assert.deepEqual([rendered.metrics.missedRemarkCount, rendered.metrics.analysisRemarkCount], [1, 0]);
});

test('optimization renderers provide presentation text and every optimization style', () => {
	const source = path.normalize('/project/source.cpp');
	const renderer = optimizationRemarksRenderer(() =>
		(['passed', 'missed', 'analysis'] as const).map((category, index) => ({
			file: source,
			line: index + 1,
			column: 1,
			pass: `${category}-pass`,
			category,
			message: `${category} detail`,
		})),
	);
	const rendered = renderer(
		rawArtifact('optimization-remarks', ''),
		display,
		renderContext('clang', { file: source, text: 'first\nsecond\nthird' }),
	);

	assert.deepEqual(
		rendered.lines.flatMap((line) => line.annotations ?? []).map(({ text, style }) => ({ text, style })),
		[
			{ text: '[passed] passed-pass: passed detail', style: 'optimization-passed' },
			{ text: '[missed] missed-pass: missed detail', style: 'optimization-missed' },
			{ text: '[analysis] analysis-pass: analysis detail', style: 'optimization-analysis' },
		],
	);
});

test('optimization remarks outside the rendered source are counted but not shown', () => {
	const context = renderContext('gcc', {
		file: path.normalize('/project/source.cpp'),
		text: 'first line\nsecond line\nthird line',
	});
	const rendered = remarks(
		rawArtifact(
			'optimization-remarks',
			[
				'/project/source.cpp:2:3: optimized: loop vectorized',
				'/project/header.h:1:1: missed: header call was not inlined',
				'/project/source.cpp:20:1: note: outside the source',
				'locationless compiler detail',
			].join('\n'),
		),
		display,
		context,
	);

	assert.deepEqual(
		rendered.lines.map((line) => line.text),
		['first line', '', 'second line', 'third line'],
	);
	assert.deepEqual(rendered.lines[1].annotations, [
		{
			kind: 'optimization-remark',
			category: 'passed',
			message: 'vectorizer: loop vectorized',
			text: '[passed] vectorizer: loop vectorized',
			style: 'optimization-passed',
		},
	]);
	assert.deepEqual(
		[rendered.metrics.remarkCount, rendered.metrics.omittedRemarkCount, rendered.metrics.missedRemarkCount],
		[1, 3, 0],
	);

	const unparsed = remarks(
		rawArtifact('optimization-remarks', 'not optimization output'),
		display,
		renderContext('gcc', { file: path.normalize('/project/source.cpp'), text: 'int main() {}\n' }),
	);
	assert.deepEqual(
		unparsed.lines.map((line) => line.text),
		['int main() {}', ''],
	);
	assert.deepEqual([unparsed.metrics.remarkCount, unparsed.metrics.omittedRemarkCount], [0, 1]);
});

test('two remarks on one source line each get their own anchor row', () => {
	const rendered = remarks(
		rawArtifact(
			'optimization-remarks',
			[
				'/project/source.cpp:2:3: optimized: loop vectorized',
				'/project/source.cpp:2:7: missed: call was not inlined',
			].join('\n'),
		),
		display,
		renderContext('gcc', { file: path.normalize('/project/source.cpp'), text: 'first line\nsecond line' }),
	);

	assert.deepEqual(
		rendered.lines.map((line) => line.text),
		['first line', '', '', 'second line'],
	);
	assert.deepEqual(
		rendered.lines.slice(1, 3).map((line) => {
			const annotation = line.annotations?.[0];
			return [annotation?.style, line.source?.column];
		}),
		[
			['optimization-passed', 2],
			['optimization-missed', 6],
		],
	);
});
