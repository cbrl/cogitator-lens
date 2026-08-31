import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { parseStackUsage } from '../../src/artifacts/stack-analysis/native-stack-analysis.js';
import { parsePythonStackUsage } from '../../src/artifacts/stack-analysis/python-stack-analysis.js';
import { readFixture } from '../support/environment.js';

const workingDirectory = path.resolve('/work');

test('.su records carry Clang, GCC, and locationless layouts through to one entry shape', () => {
	const parsed = parseStackUsage(
		[
			'src/source.c:3:clang_function\t24\tstatic',
			'C:\\work dir\\source.c:8:?windows_function@@YAHH@Z\t40\tdynamic',
			'src/source.c:locationless_function\t12\tstatic',
			'src/source.c:11:2:gcc_function\t_Z12gcc_functionv\t32\tdynamic,bounded',
		].join('\n'),
		workingDirectory,
	);

	assert.deepEqual(parsed.diagnostics, []);
	assert.deepEqual(
		parsed.entries.map((entry) => [
			entry.functionName,
			entry.sourceLine,
			entry.sourceColumn,
			entry.value,
			entry.qualifier,
		]),
		[
			['clang_function', 3, undefined, 24, 'static'],
			['?windows_function@@YAHH@Z', 8, undefined, 40, 'dynamic'],
			['locationless_function', undefined, undefined, 12, 'static'],
			['gcc_function', 11, 2, 32, 'dynamic-bounded'],
		],
	);
	assert.equal(parsed.entries[1].sourceUri, path.win32.normalize('C:\\work dir\\source.c'));
});

test('.su parsing survives demangled punctuation, duplicates, and malformed rows', () => {
	const parsed = parseStackUsage(readFixture('stack-analysis', 'gcc-clang.su'), workingDirectory);

	assert.deepEqual(
		parsed.entries.map((entry) => [entry.functionName, entry.value, entry.qualifier]),
		[
			['plain(int)', 16, 'static'],
			['network::Parser::parse<std::pair<int, int> >(char const*)', 32, 'dynamic-bounded'],
			['lambda_factory()::<lambda(int)>', 64, 'dynamic'],
			['bounded_alias()', 24, 'dynamic-bounded'],
		],
	);
	assert.equal(parsed.entries[0].sourceUri, path.resolve(workingDirectory, 'src/source.cpp'));
	assert.equal(parsed.entries[2].sourceUri, path.win32.normalize('C:\\work dir\\source.cpp'));
	assert.deepEqual(
		parsed.diagnostics.map((item) => item.line),
		[6, 7, 8],
	);

	const spaced = parseStackUsage('src/source.cpp:1:1:spaced()\t8\tdynamic, bounded', workingDirectory);
	assert.deepEqual(spaced.diagnostics, []);
	assert.equal(spaced.entries[0].qualifier, 'dynamic-bounded');
});

test('Python stack JSON is rejected unless every record is well formed', () => {
	assert.deepEqual(
		parsePythonStackUsage(
			JSON.stringify({ entries: [{ qualifiedName: 'answer', firstLine: 2, stackSize: 7, nesting: [] }] }),
		),
		[{ qualifiedName: 'answer', firstLine: 2, stackSize: 7, nesting: [] }],
	);
	// Unparseable output carries the underlying JSON failure as the cause.
	assert.throws(
		() => parsePythonStackUsage('not json'),
		(error: unknown) => error instanceof Error && error.cause instanceof SyntaxError,
	);
	assert.throws(
		() =>
			parsePythonStackUsage(
				JSON.stringify({ entries: [{ qualifiedName: 'bad', firstLine: 0, stackSize: -1, nesting: [] }] }),
			),
		Error,
	);
});
