import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import type { Uri } from 'vscode';
import { snapshotArtifactInputs, validateArtifactInputs } from '../../src/compilation/artifact-inputs.js';
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
	cache.set('first', cachedArtifact(staleInput), firstSource);
	cache.set('first', cachedArtifact(liveInput), firstSource);
	assert.deepEqual(cache.evictInput(fakeUri(staleInput)), []);
	assert.ok(cache.get('first'));

	cache.set('second', cachedArtifact(liveInput), secondSource);
	cache.set('same-source', cachedArtifact(liveInput), firstSource);
	assert.deepEqual(
		cache.evictInput(fakeUri(liveInput)).map((uri) => uri.toString()),
		[firstSource.toString(), secondSource.toString()],
	);
	for (const key of ['first', 'second', 'same-source']) {
		assert.equal(cache.get(key), undefined, `${key} survived eviction`);
	}
});

test('clearing the raw artifact cache also clears its invalidation index', () => {
	const cache = new RawArtifactCache();
	const input = path.resolve('input.h');
	cache.set('artifact', cachedArtifact(input), fakeUri(path.resolve('source.cpp')));

	cache.clear();

	assert.equal(cache.get('artifact'), undefined);
	assert.deepEqual(cache.evictInput(fakeUri(input)), []);
});

function cachedArtifact(input: string) {
	return rawArtifact('assembly', '', {
		inputs: [{ uri: pathToFileURL(input).href, size: 0, mtimeMs: 0 }],
		dependencyCoverage: 'complete',
	});
}

function fakeUri(fsPath: string): Uri {
	return { fsPath, toString: () => pathToFileURL(fsPath).href } as Uri;
}
