import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
	detectPathToolchains,
	findExecutableOnPath,
	pathCandidates,
	probeCompiler,
	rustupDisplayName,
	versionFromBanner,
} from '../../src/toolchains/path-detection.js';
import { hostCompilerFolders, parseVisualStudioInstalls } from '../../src/toolchains/visual-studio-detection.js';

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

test('PATH detection reports each directory and each versioned compiler', posixOnly, async () => {
	const first = fakeToolDirectory({
		gcc: { banner: 'gcc (Ubuntu 15.2.0-16ubuntu1) 15.2.0' },
		'gcc-14': { banner: 'gcc-14 (Ubuntu 14.3.0-1ubuntu1) 14.3.0' },
		'gcc-16': { banner: 'gcc-16 (Ubuntu 16.1.0-1ubuntu1) 16.1.0' },
		'clang-21': { banner: 'Ubuntu clang version 21.1.4' },
		'gcc-tool': { banner: 'not a compiler' },
	});
	const second = fakeToolDirectory({ gcc: { banner: 'gcc (GCC) 12.4.0' } });
	// The same file through a symlink, as /usr/bin/gcc and /usr/bin/gcc-15 on Ubuntu.
	fs.symlinkSync(path.join(first, 'gcc'), path.join(first, 'gcc-15'));
	try {
		const profiles = await detectPathToolchains({ PATH: `${first}${path.delimiter}${second}` }, 'linux');
		assert.deepEqual(
			profiles.map((profile) => [profile.id, profile.displayName, profile.detectedIn]),
			[
				['gcc', 'gcc 15.2.0', 'PATH'],
				[`gcc@${path.join(second, 'gcc')}`, 'gcc 12.4.0', second],
				['gcc-16', 'gcc-16 16.1.0', 'PATH'],
				['gcc-14', 'gcc-14 14.3.0', 'PATH'],
				['clang-21', 'clang-21 21.1.4', 'PATH'],
			],
		);
	} finally {
		fs.rmSync(first, { recursive: true, force: true });
		fs.rmSync(second, { recursive: true, force: true });
	}
});

test('two names of one interpreter give one profile', posixOnly, async () => {
	const directory = fakeToolDirectory({
		python3: { banner: 'Python 3.12.3' },
		python: { banner: 'Python 3.12.3' },
	});
	try {
		const profiles = await detectPathToolchains({ PATH: directory }, 'linux');
		assert.deepEqual(
			profiles.map((profile) => profile.id),
			['python3'],
		);
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test('rustup toolchains other than the one that the PATH rustc runs get profiles', posixOnly, async () => {
	const pathDirectory = fakeToolDirectory({ rustc: { banner: 'rustc 1.97.1 (8bab26f4f 2026-07-14)' } });
	const rustupHome = fs.mkdtempSync(path.join(os.tmpdir(), 'coglens-rustup-'));
	const toolchain = (name: string, banner: string): void => {
		const bin = path.join(rustupHome, 'toolchains', name, 'bin');
		fs.mkdirSync(bin, { recursive: true });
		fs.writeFileSync(path.join(bin, 'rustc'), `#!/bin/sh\nprintf '%s\\n' '${banner}'\n`);
		fs.chmodSync(path.join(bin, 'rustc'), 0o755);
	};
	toolchain('stable-x86_64-unknown-linux-gnu', 'rustc 1.97.1 (8bab26f4f 2026-07-14)');
	toolchain('nightly-x86_64-unknown-linux-gnu', 'rustc 1.99.0-nightly (0123abcd 2026-11-01)');
	toolchain('1.80.0-x86_64-unknown-linux-gnu', 'rustc 1.80.0 (051478957 2024-07-21)');
	fs.mkdirSync(path.join(rustupHome, 'toolchains', 'broken'));
	try {
		const profiles = await detectPathToolchains({ PATH: pathDirectory, RUSTUP_HOME: rustupHome }, 'linux');
		assert.deepEqual(
			profiles.map((profile) => [profile.id, profile.displayName, profile.detectedIn]),
			[
				['rustc', 'rustc 1.97.1', 'PATH'],
				['rustc+1.80.0-x86_64-unknown-linux-gnu', 'rustc 1.80.0', 'rustup'],
				['rustc+nightly-x86_64-unknown-linux-gnu', 'rustc 1.99.0 nightly', 'rustup'],
			],
		);
	} finally {
		fs.rmSync(pathDirectory, { recursive: true, force: true });
		fs.rmSync(rustupHome, { recursive: true, force: true });
	}
});

test('rustup toolchain names lose their host triple', () => {
	assert.equal(
		rustupDisplayName('nightly-aarch64-apple-darwin', 'rustc 1.99.0-nightly (abc 2026-11-01)'),
		'rustc 1.99.0 nightly',
	);
	assert.equal(rustupDisplayName('1.80.0-x86_64-pc-windows-msvc', 'rustc 1.80.0 (abc 2024-07-21)'), 'rustc 1.80.0');
	assert.equal(rustupDisplayName('my-toolchain', 'rustc 1.97.1 (abc 2026-07-14)'), 'rustc 1.97.1 my-toolchain');
});

test('Windows looks for cl and clang-cl on PATH', () => {
	const names = (platform: NodeJS.Platform) => pathCandidates(platform).flatMap((candidate) => candidate.names);
	assert.ok(names('win32').includes('cl'));
	assert.ok(names('win32').includes('clang-cl'));
	assert.equal(names('linux').includes('cl'), false);
});

test('vswhere installs get their product name, and a prerelease gets its milestone', () => {
	const installs = parseVisualStudioInstalls(
		JSON.stringify([
			{
				instanceId: '63454b73',
				installationPath: 'C:\\Program Files\\Microsoft Visual Studio\\18\\Insiders',
				displayName: 'Visual Studio Community 2026',
				isPrerelease: true,
				catalog: { productMilestone: 'Insiders' },
			},
			{
				instanceId: 'a1b2c3d4',
				installationPath: 'C:\\Program Files\\Microsoft Visual Studio\\2022\\BuildTools',
				displayName: 'Visual Studio Build Tools 2022',
				isPrerelease: false,
				catalog: { productMilestone: 'RTW' },
			},
			{ displayName: 'no path' },
		]),
	);
	assert.deepEqual(
		installs.map((install) => [install.instanceId, install.displayName]),
		[
			['63454b73', 'Visual Studio Community 2026 Insiders'],
			['a1b2c3d4', 'Visual Studio Build Tools 2022'],
		],
	);
	assert.deepEqual(parseVisualStudioInstalls('not json'), []);
	assert.deepEqual(hostCompilerFolders('x64'), { msvc: ['Hostx64', 'x64'], llvm: ['x64', 'bin'] });
	assert.deepEqual(hostCompilerFolders('arm64')?.msvc, ['HostArm64', 'arm64']);
	assert.equal(hostCompilerFolders('ppc64'), undefined);
});

test('a configured compiler gets its kind from its name and its banner', posixOnly, async () => {
	const directory = fakeToolDirectory({
		gcc: { banner: 'Apple clang version 15.0.0 (clang-1500.3.9.4)' },
		'gcc-14': { banner: 'gcc-14 (Ubuntu 14.2.0-4ubuntu2) 14.2.0' },
		'g++': { banner: 'Ubuntu clang version 18.1.3 (1ubuntu1)' },
		clang: { banner: 'broken', code: 1 },
	});
	const kind = async (name: string) => (await probeCompiler(path.join(directory, name), process.env, 'linux'))?.kind;
	try {
		assert.equal(await kind('gcc'), 'apple-clang', 'The gcc of macOS is Apple Clang');
		assert.equal(await kind('gcc-14'), 'gcc');
		assert.equal(await kind('g++'), 'clang');
		assert.equal(await kind('clang'), undefined, 'A compiler that fails gives nothing');
		assert.equal(await kind('gcc-99'), undefined, 'A missing compiler gives nothing');
		assert.equal(await kind('make'), undefined, 'An unsupported name does not run');
		assert.match(
			(await probeCompiler(path.join(directory, 'gcc-14'), process.env, 'linux'))?.banner ?? '',
			/14\.2\.0/,
		);
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});
