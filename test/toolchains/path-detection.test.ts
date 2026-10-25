import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
	detectPathToolchains,
	findExecutableOnPath,
	pathCandidates,
	versionFromBanner,
} from '../../src/toolchains/path-detection.js';

const posixOnly = { skip: process.platform === 'win32' ? 'uses POSIX shell scripts as fake tools' : false };

/** Creates a directory of fake tools that print a banner and exit with a code. */
function fakeToolDirectory(
	tools: Readonly<Record<string, { readonly banner: string; readonly code?: number }>>,
): string {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coglens-path-'));
	for (const [name, tool] of Object.entries(tools)) {
		const file = path.join(directory, name);
		fs.writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' '${tool.banner}'\nexit ${tool.code ?? 0}\n`);
		fs.chmodSync(file, 0o755);
	}
	return directory;
}

test('version banners yield their first version number', () => {
	assert.equal(versionFromBanner('gcc (Ubuntu 13.2.0-23ubuntu4) 13.2.0'), '13.2.0');
	assert.equal(versionFromBanner('Apple clang version 15.0.0 (clang-1500.3.9.4)'), '15.0.0');
	assert.equal(versionFromBanner('go version go1.22.2 linux/amd64'), '1.22.2');
	assert.equal(versionFromBanner('Python 3.12.3'), '3.12.3');
	assert.equal(versionFromBanner('no version here'), undefined);
});

test('Windows prefers python.exe and the py launcher over the python3 Store alias', () => {
	const python = (platform: NodeJS.Platform) =>
		pathCandidates(platform).find((candidate) => candidate.names.includes('python'))?.names;
	assert.deepEqual(python('win32'), ['python', 'py', 'python3']);
	assert.deepEqual(python('linux'), ['python3', 'python']);
});

test('PATH lookup skips relative entries and files that are not executable', posixOnly, async () => {
	const directory = fakeToolDirectory({ zig: { banner: '0.13.0' } });
	const notExecutable = path.join(directory, 'rustc');
	fs.writeFileSync(notExecutable, '');
	try {
		assert.equal(await findExecutableOnPath('zig', { PATH: directory }, 'linux'), path.join(directory, 'zig'));
		assert.equal(await findExecutableOnPath('rustc', { PATH: directory }, 'linux'), undefined);
		const relative = path.relative(process.cwd(), directory);
		assert.equal(await findExecutableOnPath('zig', { PATH: relative }, 'linux'), undefined);
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test('PATH detection keeps tools whose version command works', posixOnly, async () => {
	const directory = fakeToolDirectory({
		// Apple's gcc is a clang shim, and clang is detected on its own.
		gcc: { banner: 'Apple clang version 15.0.0 (clang-1500.3.9.4)' },
		clang: { banner: 'Ubuntu clang version 18.1.3 (1ubuntu1)' },
		rustc: { banner: 'error: broken installation', code: 1 },
		python3: { banner: 'Python 2.7.18' },
		python: { banner: 'Python 3.12.3' },
		go: { banner: 'go version go1.22.2 linux/amd64' },
	});
	try {
		const profiles = await detectPathToolchains({ PATH: directory }, 'linux');
		assert.deepEqual(
			profiles.map((profile) => [profile.id, profile.kind, profile.displayName, profile.executable]),
			[
				['clang', 'clang', 'clang 18.1.3', path.join(directory, 'clang')],
				['python', 'python', 'python 3.12.3', path.join(directory, 'python')],
				['go', 'go', 'go 1.22.2', path.join(directory, 'go')],
			],
		);
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});
