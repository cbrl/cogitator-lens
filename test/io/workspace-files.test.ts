import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import type { Uri } from 'vscode';
import {
	artifactInputComparisonKey,
	snapshotArtifactInputs,
	validateArtifactInputs,
} from '../../src/compilation/artifact-inputs.js';
import { RawArtifactCache } from '../../src/compilation/raw-artifact-cache.js';
import { withTemporaryDirectory } from '../../src/temporary-directory.js';
import { rawArtifact } from '../support/artifacts.js';

test('temporary directories are removed after both success and failure', async () => {
	const directories: string[] = [];
	await withTemporaryDirectory('coglens-test-', async (directory) => {
		directories.push(directory);
		await fs.promises.mkdir(path.join(directory, 'nested'));
		await fs.promises.writeFile(path.join(directory, 'nested', 'output'), 'complete');
	});
	await assert.rejects(
		withTemporaryDirectory('coglens-test-', async (directory) => {
			directories.push(directory);
			await fs.promises.writeFile(path.join(directory, 'partial'), 'partial');
			throw new Error('expected failure');
		}),
		/expected failure/,
	);
	assert.ok(directories.every((directory) => !fs.existsSync(directory)));
});

test('input snapshots detect a changed or deleted dependency', async () => {
	const temporary = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'coglens-inputs-'));
	try {
		const source = path.join(temporary, 'source.cpp');
		const header = path.join(temporary, 'header.h');
		await Promise.all([
			fs.promises.writeFile(source, 'int main() {}\n'),
			fs.promises.writeFile(header, '#pragma once\n'),
		]);

		const snapshot = await snapshotArtifactInputs(source, [header], 'complete', temporary);
		assert.equal(snapshot.inputs.length, 2);
		assert.equal(await validateArtifactInputs(snapshot.inputs), true);

		await fs.promises.rm(header);
		assert.equal(await validateArtifactInputs(snapshot.inputs), false);
	} finally {
		await fs.promises.rm(temporary, { recursive: true, force: true });
	}
});

test('the raw artifact cache keeps its dependency index correct across replacement', () => {
	const cache = new RawArtifactCache();
	const staleInput = path.resolve('old-input.h');
	const liveInput = path.resolve('current-input.h');
	const firstSource = fakeUri(path.resolve('first.cpp'));
	const secondSource = fakeUri(path.resolve('second.cpp'));

	// Replacing an entry must drop the inputs only the replaced entry depended on.
	cache.set('first', cachedArtifact(staleInput), firstSource, 'toolchain');
	cache.set('first', cachedArtifact(liveInput), firstSource, 'toolchain');
	assert.deepEqual(cache.evictInputKey(artifactInputComparisonKey(pathToFileURL(staleInput).href)), []);
	assert.ok(cache.get('first'));

	cache.set('second', cachedArtifact(liveInput), secondSource, 'toolchain');
	cache.set('same-source', cachedArtifact(liveInput), firstSource, 'toolchain');
	assert.deepEqual(
		cache.evictInputKey(artifactInputComparisonKey(pathToFileURL(liveInput).href)).map((uri) => uri.toString()),
		[firstSource.toString(), secondSource.toString()],
	);
	for (const key of ['first', 'second', 'same-source']) {
		assert.equal(cache.get(key), undefined, `${key} survived eviction`);
	}
});

test('clearing the raw artifact cache also clears its invalidation index', () => {
	const cache = new RawArtifactCache();
	const input = path.resolve('input.h');
	cache.set('artifact', cachedArtifact(input), fakeUri(path.resolve('source.cpp')), 'toolchain');

	cache.clear();

	assert.equal(cache.get('artifact'), undefined);
	assert.deepEqual(cache.evictInputKey(artifactInputComparisonKey(pathToFileURL(input).href)), []);
	assert.deepEqual([...cache.getInputs().values()], []);
});

test('the raw artifact cache reports each live input once', () => {
	const cache = new RawArtifactCache();
	const sharedInput = path.resolve('shared-input.h');
	const otherInput = path.resolve('other-input.h');
	cache.set('first', cachedArtifact(sharedInput), fakeUri(path.resolve('first.cpp')), 'toolchain');
	cache.set('second', cachedArtifact(sharedInput), fakeUri(path.resolve('second.cpp')), 'toolchain');
	cache.set('other', cachedArtifact(otherInput), fakeUri(path.resolve('other.cpp')), 'toolchain');

	assert.deepEqual(
		new Set([...cache.getInputs().values()]),
		new Set([pathToFileURL(sharedInput).href, pathToFileURL(otherInput).href]),
	);

	cache.delete('first');
	assert.deepEqual(
		new Set([...cache.getInputs().values()]),
		new Set([pathToFileURL(sharedInput).href, pathToFileURL(otherInput).href]),
	);
	cache.delete('second');
	assert.deepEqual([...cache.getInputs().values()], [pathToFileURL(otherInput).href]);
});

test(
	'cache invalidation retains a symlinked input identity after deletion',
	{ skip: process.platform === 'win32' },
	() => {
		const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'coglens-cache-identity-'));
		try {
			const physical = path.join(temporary, 'physical');
			const alias = path.join(temporary, 'alias');
			fs.mkdirSync(physical);
			fs.symlinkSync(physical, alias, 'dir');
			const input = path.join(physical, 'header.h');
			const aliasedInput = path.join(alias, 'header.h');
			fs.writeFileSync(input, '#pragma once\n');

			const cache = new RawArtifactCache();
			cache.set('artifact', cachedArtifact(input), fakeUri(path.join(alias, 'source.cpp')), 'toolchain');
			const watcherKey = artifactInputComparisonKey(pathToFileURL(aliasedInput).href);
			fs.rmSync(input);

			assert.equal(cache.evictInputKey(watcherKey).length, 1);
			assert.equal(cache.get('artifact'), undefined);
		} finally {
			fs.rmSync(temporary, { recursive: true, force: true });
		}
	},
);

test('the raw artifact cache evicts the least recently used output over its budget', () => {
	const source = fakeUri(path.resolve('source.cpp'));
	const byCharacters = new RawArtifactCache(10, 100);
	byCharacters.set('a', cachedArtifact(path.resolve('a.h'), 'aaaa'), source, 'toolchain');
	byCharacters.set('b', cachedArtifact(path.resolve('b.h'), 'bbbb'), source, 'toolchain');
	assert.ok(byCharacters.get('a'), 'Reading an output makes it the most recent');
	byCharacters.set('c', cachedArtifact(path.resolve('c.h'), 'cccc'), source, 'toolchain');
	assert.deepEqual(
		['a', 'b', 'c'].map((key) => Boolean(byCharacters.get(key))),
		[true, false, true],
	);
	assert.deepEqual(
		byCharacters.evictInputKey(artifactInputComparisonKey(pathToFileURL(path.resolve('b.h')).href)),
		[],
	);

	const byEntries = new RawArtifactCache(1_000, 2);
	for (const key of ['a', 'b', 'c']) {
		byEntries.set(key, cachedArtifact(path.resolve(`${key}.h`)), source, 'toolchain');
	}
	assert.equal(byEntries.size, 2);
	assert.equal(byEntries.get('a'), undefined);

	const oversized = new RawArtifactCache(2, 10);
	oversized.set('large', cachedArtifact(path.resolve('large.h'), 'too large'), source, 'toolchain');
	assert.ok(oversized.get('large'), 'The newest output stays even when it alone exceeds the budget');
});

test('a toolchain change evicts only the outputs of that toolchain', () => {
	const cache = new RawArtifactCache();
	const first = fakeUri(path.resolve('first.cpp'));
	const second = fakeUri(path.resolve('second.cpp'));
	cache.set('gcc', cachedArtifact(path.resolve('a.h')), first, 'path:gcc');
	cache.set('clang', cachedArtifact(path.resolve('b.h')), second, 'path:clang');
	assert.deepEqual(
		cache.evictToolchains(new Set(['path:gcc'])).map((uri) => uri.fsPath),
		[first.fsPath],
	);
	assert.equal(cache.get('gcc'), undefined);
	assert.ok(cache.get('clang'));
	assert.deepEqual([...cache.getInputs().values()], [pathToFileURL(path.resolve('b.h')).href]);
});

test('the raw artifact cache reports only the inputs a watcher filter accepts', () => {
	const cache = new RawArtifactCache();
	const project = path.resolve('project');
	cache.set(
		'first',
		cachedArtifact(path.join(project, 'header.h')),
		fakeUri(path.join(project, 'main.cpp')),
		'toolchain',
	);
	cache.set(
		'second',
		cachedArtifact(path.resolve('/usr/include/stdio.h')),
		fakeUri(path.join(project, 'main.cpp')),
		'toolchain',
	);
	assert.deepEqual(
		[...cache.getInputs((input) => input.startsWith(project)).values()],
		[pathToFileURL(path.join(project, 'header.h')).href],
	);
});

function cachedArtifact(input: string, text = '') {
	return rawArtifact('assembly', text, {
		inputs: [{ uri: pathToFileURL(input).href, size: 0, mtimeMs: 0 }],
		dependencyCoverage: 'complete',
	});
}

function fakeUri(fsPath: string): Uri {
	return { fsPath, toString: () => pathToFileURL(fsPath).href } as Uri;
}
