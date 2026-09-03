import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import type { Uri } from 'vscode';
import {
	canonicalLocalPath,
	localFileComparisonKey,
	localFileUriComparisonKey,
	sameLocalFile,
} from '../src/local-file-identity.js';
import { artifactInputComparisonKey } from '../src/compilation/artifact-inputs.js';
import { diagnosticUri } from '../src/diagnostics.js';
import { stripDotNetManagedArguments } from '../src/toolchains/dotnet.js';
import { stripGoManagedArguments } from '../src/toolchains/go.js';
import { stripNvccManagedArguments } from '../src/toolchains/nvcc.js';
import { stripZigManagedArguments } from '../src/toolchains/zig.js';

test(
	'local file identity unifies symlink aliases and nonexistent descendants',
	{ skip: process.platform === 'win32' },
	() => {
		const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'coglens-file-identity-'));
		try {
			const physical = path.join(temporary, 'physical');
			const alias = path.join(temporary, 'alias');
			fs.mkdirSync(physical);
			fs.writeFileSync(path.join(physical, 'source.cs'), 'class Source {}');
			fs.symlinkSync(physical, alias, 'dir');

			const physicalSource = path.join(physical, 'source.cs');
			const aliasedSource = path.join(alias, 'source.cs');
			assert.equal(sameLocalFile(physicalSource, aliasedSource), true);
			assert.equal(canonicalLocalPath(aliasedSource), fs.realpathSync(physicalSource));
			assert.equal(localFileComparisonKey(physicalSource), localFileComparisonKey(aliasedSource));
			assert.equal(
				localFileComparisonKey(path.join(physical, 'generated', 'output.o')),
				localFileComparisonKey(path.join(alias, 'generated', 'output.o')),
			);
			assert.equal(
				artifactInputComparisonKey(pathToFileURL(physicalSource).href),
				artifactInputComparisonKey(pathToFileURL(aliasedSource).href),
			);
			const sourceUri = fakeUri(aliasedSource);
			assert.equal(
				localFileUriComparisonKey(sourceUri),
				JSON.stringify(['file', localFileComparisonKey(physicalSource), '']),
			);
			assert.equal(diagnosticUri(physicalSource, sourceUri, temporary), sourceUri);
		} finally {
			fs.rmSync(temporary, { recursive: true, force: true });
		}
	},
);

test(
	'managed argument stripping recognizes a source reached through a symlink',
	{ skip: process.platform === 'win32' },
	() => {
		const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'coglens-argument-identity-'));
		try {
			const physical = path.join(temporary, 'physical');
			const alias = path.join(temporary, 'alias');
			fs.mkdirSync(physical);
			fs.writeFileSync(path.join(physical, 'source.cs'), 'class Source {}');
			fs.symlinkSync(physical, alias, 'dir');
			const source = path.join(physical, 'source.cs');
			const argument = path.relative(temporary, path.join(alias, 'source.cs'));

			assert.deepEqual(stripDotNetManagedArguments([argument, '-optimize'], source, temporary), ['-optimize']);
			assert.deepEqual(stripGoManagedArguments([argument, '-v'], source, temporary), ['-v']);
			assert.deepEqual(stripNvccManagedArguments([argument, '--use_fast_math'], source, temporary), [
				'--use_fast_math',
			]);
			assert.deepEqual(stripZigManagedArguments([argument, '-OReleaseFast'], source, temporary), [
				'-OReleaseFast',
			]);
		} finally {
			fs.rmSync(temporary, { recursive: true, force: true });
		}
	},
);

function fakeUri(fsPath: string): Uri {
	return {
		scheme: 'file',
		fsPath,
		query: '',
		toString: () => pathToFileURL(fsPath).href,
		with: () => fakeUri(fsPath),
	} as unknown as Uri;
}
