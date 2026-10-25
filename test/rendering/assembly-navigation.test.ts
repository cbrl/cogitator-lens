import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { functionLabelTest } from '../../src/artifacts/assembly/assembly-navigation.js';
import { renderAssembly } from '../../src/artifacts/assembly/assembly-renderer.js';
import { defaultArtifactOptions, type DisplayOptions, type RenderedTextArtifact } from '../../src/types/index.js';
import { rawArtifact, renderContext } from '../support/artifacts.js';
import { readFixture } from '../support/environment.js';

// g++ -O0 output for a loop in /project/source.cpp that calls an inline function from /project/helper.h.
const listing = readFixture('assembly', 'gcc-library-code.s');
const source = path.resolve('/project/source.cpp');

function render(display: Partial<DisplayOptions> = {}): RenderedTextArtifact {
	return renderAssembly(
		rawArtifact('assembly', listing),
		{ ...defaultArtifactOptions.display, ...display },
		renderContext('gcc', { file: source }),
	);
}

function lineOf(artifact: RenderedTextArtifact, text: string): number {
	const index = artifact.lines.findIndex((line) => line.text.trim() === text);
	assert.notEqual(index, -1, `missing line ${text}`);
	return index;
}

test('assembly links, outline entries, and folds start on their label lines', () => {
	const artifact = render({ libraryCode: false });
	const jump = artifact.lines.findIndex((line) => /^\s*jmp\s+\.L4\b/.test(line.text));
	const branch = artifact.lines.findIndex((line) => /^\s*jle\s+\.L5\b/.test(line.text));
	assert.equal(artifact.links.find((link) => link.line === jump)?.targetLine, lineOf(artifact, '.L4:'));
	assert.equal(artifact.links.find((link) => link.line === branch)?.targetLine, lineOf(artifact, '.L5:'));

	const helper = lineOf(artifact, '_Z6helperi:');
	const count = lineOf(artifact, '_Z5counti:');
	assert.deepEqual(
		artifact.symbols.map((symbol) => [symbol.name, symbol.line]),
		[
			['_Z6helperi', helper],
			['_Z5counti', count],
		],
		'Local labels are not outline symbols',
	);
	assert.deepEqual(artifact.folds, [
		{ startLine: helper, endLine: count - 1 },
		{ startLine: count, endLine: artifact.lines.length - 1 },
	]);
});

test('Hide library code keeps the compiled file and removes header functions', () => {
	const all = render({ libraryCode: false });
	assert.ok(all.lines.some((line) => line.text.trim() === '_Z6helperi:'));
	assert.ok(all.lines.some((line) => line.source?.file?.endsWith('helper.h')));

	const filtered = render({ libraryCode: true });
	assert.equal(
		filtered.lines.some((line) => line.text.trim() === '_Z6helperi:'),
		false,
	);
	assert.ok(filtered.lines.some((line) => line.text.trim() === '_Z5counti:'));
	assert.ok(filtered.lines.some((line) => line.source?.file === source && line.source.line === 4));
	assert.equal(
		filtered.lines.some((line) => line.source?.file?.endsWith('helper.h')),
		false,
	);
});

test('the compiled file keeps its path when filenames are masked', () => {
	for (const dontMaskFilenames of [true, false]) {
		const artifact = render({ dontMaskFilenames });
		const mapped = artifact.lines.filter((line) => line.source?.line === 3);
		assert.ok(mapped.length > 0);
		assert.ok(
			mapped.every((line) => line.source?.file === source),
			`dontMaskFilenames=${dontMaskFilenames}`,
		);
	}
});

test('demangled function labels stay in the outline', () => {
	// The demangler rewrites labels and type directives alike; the parser does not define such labels.
	const demangled = listing.replaceAll('_Z6helperi', 'helper(int)').replaceAll('_Z5counti', 'count(int)');
	const artifact = renderAssembly(
		rawArtifact('assembly', demangled),
		defaultArtifactOptions.display,
		renderContext('gcc', { file: source }),
	);
	assert.deepEqual(
		artifact.symbols.map((symbol) => [symbol.name, symbol.line]),
		[
			['helper(int)', lineOf(artifact, 'helper(int):')],
			['count(int)', lineOf(artifact, 'count(int):')],
		],
	);
});

test('function labels come from type directives, or from Mach-O symbol names', () => {
	const elf = functionLabelTest('\t.type\tmain, @function\nmain:\n.L2:\n');
	assert.equal(elf?.('main'), true);
	assert.equal(elf?.('.L2'), false);

	const coff = functionLabelTest('\t.def\tmain;\t.scl\t2;\t.type\t32;\t.endef\nmain:\n');
	assert.equal(coff?.('main'), true);

	const machO = functionLabelTest('\t.build_version macos, 14, 0\n_main:\nLBB0_2:\n\t.subsections_via_symbols\n');
	assert.equal(machO?.('_main'), true);
	assert.equal(machO?.('LBB0_2'), false);

	assert.equal(functionLabelTest('main:\n\tret\n'), undefined);
});
