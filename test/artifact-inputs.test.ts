import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
	parseMakeDepfile,
	parseMsvcSourceDependencies,
	snapshotArtifactInputs,
	validateArtifactInputs,
} from '../src/compilation/artifact-inputs.js';

test('Make depfiles handle continuations, escaped spaces, multiple targets, and drive letters', () => {
	const workingDirectory = path.resolve('/project');
	const parsed = parseMakeDepfile([
		'output.o output.d: src/main.cpp include/a\\ header.h \\',
		' include/next.h',
		'C:\\build\\other.o: C:\\src\\other.cpp C:\\src\\with\\ space.h',
	].join('\n'), workingDirectory);
	assert.ok(parsed.some(filename => filename.endsWith(path.join('src', 'main.cpp'))));
	assert.ok(parsed.some(filename => filename.endsWith(path.join('include', 'a header.h'))));
	assert.ok(parsed.some(filename => filename.endsWith(path.join('include', 'next.h'))));
	assert.ok(parsed.some(filename => filename.includes('other.cpp')));
	assert.ok(parsed.some(filename => filename.includes('with space.h')));
});

test('MSVC source-dependency JSON accepts documented source and include fields only', () => {
	const dependencies = parseMsvcSourceDependencies(JSON.stringify({
		Version: '1.2',
		Data: {
			Source: 'src/main.cpp',
			Includes: ['include/a.h'],
			ImportedModules: [{ Name: 'ignored' }],
		},
	}), path.resolve('/project'));
	assert.equal(dependencies.length, 2);
	assert.ok(dependencies[0].endsWith(path.join('include', 'a.h'))
		|| dependencies[1].endsWith(path.join('include', 'a.h')));
	assert.deepEqual(parseMsvcSourceDependencies('not json', '/project'), []);
});

test('artifact input snapshots validate changes and deleted dependencies', async () => {
	const temporary = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'coglens-inputs-'));
	try {
		const source = path.join(temporary, 'source.cpp');
		const header = path.join(temporary, 'header.h');
		await Promise.all([
			fs.promises.writeFile(source, 'int main() {}\n'),
			fs.promises.writeFile(header, '#pragma once\n'),
		]);
		const snapshot = await snapshotArtifactInputs(
			source,
			[header],
			'complete',
			temporary,
		);
		assert.equal(snapshot.inputs.length, 2);
		assert.equal(await validateArtifactInputs(snapshot.inputs), true);
		await fs.promises.rm(header);
		assert.equal(await validateArtifactInputs(snapshot.inputs), false);
	} finally {
		await fs.promises.rm(temporary, { recursive: true, force: true });
	}
});
