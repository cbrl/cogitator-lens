import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { functionLabelTest } from '../../src/artifacts/assembly/assembly-navigation.js';
import { unescapeAssemblyString } from '../../src/artifacts/assembly/main-source.js';
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
	const artifact = render({ showLibraryCode: true });
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
	const all = render({ showLibraryCode: true });
	assert.ok(all.lines.some((line) => line.text.trim() === '_Z6helperi:'));
	assert.ok(all.lines.some((line) => line.source?.file?.endsWith('helper.h')));

	const filtered = render({ showLibraryCode: false });
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

test('lines of the compiled file carry its path', () => {
	const mapped = render().lines.filter((line) => line.source?.line === 3);
	assert.ok(mapped.length > 0);
	assert.ok(mapped.every((line) => line.source?.file === source));
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

test('LLVM function labels with a trailing comment are outline symbols on every target', () => {
	const listings = {
		elf: '\t.type\tcount(int),@function\ncount(int):                # @count(int)\n.LBB0_1:  # =>This Inner Loop Header\n\tret\n',
		aarch64: '\t.type\t_Z5counti,@function\n_Z5counti:                 // @_Z5counti\n// %bb.0:\n.LBB0_1:\n\tret\n',
		machO: '\t.build_version macos, 14, 0\n__Z5counti:                ## @_Z5counti\nLBB0_1:   ## =>This Inner Loop Header\n\tretq\n',
		msvc: '\t.def\t"?count@@YAHH@Z";\n\t.scl\t2;\n\t.type\t32;\n\t.endef\n"?count@@YAHH@Z":          # @"?count@@YAHH@Z"\n.LBB0_1:\n\tretq\n',
		mingw: '\t.def\t@feat.00;\n\t.scl\t3;\n\t.type\t0;\n\t.endef\n\t.def\t_Z5counti;\n\t.scl\t2;\n\t.type\t32;\n\t.endef\n_Z5counti:   # @_Z5counti\n.LBB0_1:\n\tretq\n',
	};
	const expected = {
		elf: 'count(int)',
		aarch64: '_Z5counti',
		machO: '__Z5counti',
		msvc: '?count@@YAHH@Z',
		mingw: '_Z5counti',
	};
	for (const [target, text] of Object.entries(listings)) {
		const artifact = renderAssembly(
			rawArtifact('assembly', text),
			{ ...defaultArtifactOptions.display, showLibraryCode: true },
			renderContext('clang', { file: source }),
		);
		assert.deepEqual(
			artifact.symbols.map((symbol) => symbol.name),
			[expected[target as keyof typeof expected]],
			target,
		);
		assert.equal(artifact.folds?.length, 1, `${target} folds the function once`);
	}
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

test('a compiled file whose path has escaped non-ASCII bytes is still the main source', () => {
	// GCC and LLVM write each byte outside printable ASCII as an octal escape.
	const accented = path.resolve('/projé/source.cpp');
	const escaped = accented.replaceAll('\\', '\\\\').replace('é', '\\303\\251');
	const text = listing.replaceAll('/project/source.cpp', escaped).replaceAll('/project/helper.h', '/projé/helper.h');
	const render = (display: Partial<DisplayOptions>) =>
		renderAssembly(
			rawArtifact('assembly', text),
			{ ...defaultArtifactOptions.display, ...display },
			renderContext('gcc', { file: accented }),
		);
	const filtered = render({ showLibraryCode: false });
	assert.ok(filtered.lines.some((line) => line.text.trim() === '_Z5counti:'));
	assert.ok(filtered.lines.some((line) => line.source?.file === accented && line.source.mainSource));

	// Shown directives keep the file names the compiler wrote, checksums included.
	const directives = render({ showLibraryCode: true, showDirectives: true });
	const fileLines = directives.lines.filter((line) => /^\s*\.file\s+\d/.test(line.text)).map((line) => line.text);
	assert.ok(fileLines.length > 0);
	assert.ok(
		fileLines.every((line) => !line.includes('<source>')),
		fileLines.join('\n'),
	);
	assert.ok(fileLines.some((line) => line.includes(escaped)));
});

test('Hide library code keeps the functions an MSVC listing attributes to the compiled file', () => {
	const helper = path.resolve('/project/helper.h');
	const msvcListing = [
		'; Function compile flags: /Odtp',
		'_TEXT\tSEGMENT',
		'helper PROC',
		`; File ${helper}`,
		'; Line 2',
		'\tret\t0',
		'helper ENDP',
		'_TEXT\tENDS',
		'; Function compile flags: /Odtp',
		'_TEXT\tSEGMENT',
		'count PROC',
		`; File ${source}`,
		'; Line 4',
		'\tcall\thelper',
		'\tret\t0',
		'count ENDP',
		'_TEXT\tENDS',
		'END',
	].join('\n');
	const artifact = renderAssembly(
		rawArtifact('assembly', msvcListing),
		{ ...defaultArtifactOptions.display, showLibraryCode: false },
		renderContext('msvc', { file: source }),
	);
	assert.ok(artifact.lines.some((line) => line.text.trim() === 'count PROC'));
	assert.equal(
		artifact.lines.some((line) => line.text.trim() === 'helper PROC'),
		false,
	);
	assert.ok(artifact.lines.some((line) => line.source?.file === source && line.source.line === 4));
});

test('assembler strings decode octal UTF-8 bytes and character escapes', () => {
	assert.equal(unescapeAssemblyString(String.raw`/jos\303\251/a\\b\"c\td`), '/josé/a\\b"c\td');
	assert.equal(unescapeAssemblyString('/plain/𝔵.c'), '/plain/𝔵.c');
	assert.equal(unescapeAssemblyString(String.raw`/mixed/𝔵\303\251.c`), '/mixed/𝔵é.c');
});
