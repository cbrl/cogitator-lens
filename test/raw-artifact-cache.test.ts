import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import type { Uri } from 'vscode';
import { RawArtifactCache } from '../src/compilation/raw-artifact-cache.js';
import type { RawArtifact } from '../src/types/index.js';

test('raw artifact cache maintains dependency indexes across replacement and eviction', () => {
	const cache = new RawArtifactCache();
	const oldInput = path.resolve('old-input.h');
	const currentInput = path.resolve('current-input.h');
	const firstSource = fakeUri(path.resolve('first.cpp'));
	const secondSource = fakeUri(path.resolve('second.cpp'));

	cache.set('first', artifact(oldInput), firstSource);
	cache.set('first', artifact(currentInput), firstSource);
	assert.equal(cache.evictInput(fakeUri(oldInput)).length, 0);
	assert.ok(cache.get('first'));

	cache.set('second', artifact(currentInput), secondSource);
	cache.set('same-source', artifact(currentInput), firstSource);
	assert.deepEqual(
		cache.evictInput(fakeUri(currentInput)).map(uri => uri.toString()),
		[firstSource.toString(), secondSource.toString()],
	);
	assert.equal(cache.get('first'), undefined);
	assert.equal(cache.get('second'), undefined);
	assert.equal(cache.get('same-source'), undefined);
});

test('raw artifact cache clear removes artifacts and invalidation indexes', () => {
	const cache = new RawArtifactCache();
	const input = path.resolve('input.h');
	cache.set('artifact', artifact(input), fakeUri(path.resolve('source.cpp')));

	cache.clear();

	assert.equal(cache.get('artifact'), undefined);
	assert.deepEqual(cache.evictInput(fakeUri(input)), []);
});

function artifact(input: string): RawArtifact {
	return {
		kind: 'assembly',
		text: '',
		diagnostics: [],
		durationMs: 0,
		generatedAt: 0,
		command: {
			executable: 'compiler',
			arguments: [],
			workingDirectory: '.',
			environmentVariableNames: [],
		},
		truncated: false,
		inputs: [{ uri: pathToFileURL(input).href, size: 0, mtimeMs: 0 }],
		dependencyCoverage: 'complete',
	};
}

function fakeUri(fsPath: string): Uri {
	return {
		fsPath,
		toString: () => pathToFileURL(fsPath).href,
	} as Uri;
}
