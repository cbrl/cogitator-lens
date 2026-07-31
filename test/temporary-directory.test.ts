import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { withTemporaryDirectory } from '../src/temporary-directory.js';

test('removes temporary directories after success and failure', async () => {
	const directories: string[] = [];
	await withTemporaryDirectory('coglens-test-', async directory => {
		directories.push(directory);
		await fs.promises.mkdir(path.join(directory, 'nested'));
		await fs.promises.writeFile(path.join(directory, 'nested', 'output'), 'complete');
	});
	await assert.rejects(withTemporaryDirectory('coglens-test-', async directory => {
		directories.push(directory);
		await fs.promises.writeFile(path.join(directory, 'partial'), 'partial');
		throw new Error('expected failure');
	}), /expected failure/);
	assert.ok(directories.every(directory => !fs.existsSync(directory)));
});
