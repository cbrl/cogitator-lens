import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
	architectureOfTriple,
	msvcTarget,
	targetFromArguments,
	targetFromClangBanner,
	toolchainTarget,
} from '../../src/toolchains/target-architecture.js';
import { toolchainProfile } from '../support/toolchains.js';

test('a target triple names its instruction set', () => {
	assert.equal(architectureOfTriple('x86_64-pc-linux-gnu'), 'x86');
	assert.equal(architectureOfTriple('i686-w64-mingw32'), 'x86');
	assert.equal(architectureOfTriple('aarch64-linux-gnu'), 'aarch64');
	assert.equal(architectureOfTriple('arm64-apple-darwin'), 'aarch64');
	assert.equal(architectureOfTriple('armv7a-none-eabi'), 'arm32');
	assert.equal(architectureOfTriple('thumbv7em-none-eabihf'), 'arm32');
	assert.equal(architectureOfTriple('riscv64gc-unknown-linux-gnu'), 'riscv64');
	assert.equal(architectureOfTriple('powerpc64le-linux-gnu'), 'power');
	assert.equal(architectureOfTriple('nvptx64-nvidia-cuda'), 'ptx');
	assert.equal(architectureOfTriple('wasm32-unknown-unknown'), undefined);
	assert.equal(architectureOfTriple(undefined), undefined);
});

test('the last target argument applies', () => {
	assert.equal(targetFromArguments(['-O2', '--target=aarch64-linux-gnu']), 'aarch64-linux-gnu');
	assert.equal(targetFromArguments(['-target', 'riscv64-linux-gnu', '-O2']), 'riscv64-linux-gnu');
	assert.equal(targetFromArguments(['--target', 'x86_64-unknown-linux-gnu']), 'x86_64-unknown-linux-gnu');
	assert.equal(targetFromArguments(['/clang:--target=armv7-pc-windows-msvc']), 'armv7-pc-windows-msvc');
	assert.equal(targetFromArguments(['-arch', 'arm64']), 'arm64-apple-darwin');
	assert.equal(
		targetFromArguments(['--target=x86_64-linux-gnu', '-target', 'aarch64-linux-gnu']),
		'aarch64-linux-gnu',
	);
	assert.equal(targetFromArguments(['-O2', '-target']), undefined);
	assert.equal(targetFromArguments([]), undefined);
});

test('the path of cl.exe names its target', () => {
	const toolset = 'C:\\VS\\VC\\Tools\\MSVC\\14.52.37025\\bin';
	assert.equal(msvcTarget(`${toolset}\\Hostx64\\x64\\cl.exe`), 'x86_64-pc-windows-msvc');
	assert.equal(msvcTarget(`${toolset}\\Hostx64\\arm64\\cl.exe`), 'aarch64-pc-windows-msvc');
	assert.equal(msvcTarget(`${toolset}\\Hostx86\\x86\\cl.exe`), 'i686-pc-windows-msvc');
	assert.equal(msvcTarget('cl.exe', 'x64'), 'x86_64-pc-windows-msvc');
	assert.equal(msvcTarget('cl.exe', 'arm64'), 'aarch64-pc-windows-msvc');
});

test('a Clang banner names the default target', () => {
	assert.equal(
		targetFromClangBanner(
			'clang version 22.1.3 (https://github.com/llvm/llvm-project)\nTarget: x86_64-pc-windows-msvc\nThread model: posix',
		),
		'x86_64-pc-windows-msvc',
	);
	assert.equal(targetFromClangBanner('gcc (GCC) 15.2.0'), undefined);
});

test('the target of a profile applies without a process', async () => {
	assert.equal(
		await toolchainTarget(toolchainProfile('gcc', { executable: '/missing/gcc', target: 'powerpc64le-linux-gnu' })),
		'powerpc64le-linux-gnu',
	);
	assert.equal(
		await toolchainTarget(toolchainProfile('msvc', { executable: 'C:\\VS\\bin\\Hostx64\\arm64\\cl.exe' })),
		'aarch64-pc-windows-msvc',
	);
	// A compiler that does not run reports nothing.
	assert.equal(await toolchainTarget(toolchainProfile('gcc', { executable: '/missing/compiler/gcc' })), undefined);
	assert.equal(await toolchainTarget(toolchainProfile('python')), undefined);
});

test(
	'a failed target report is asked again, and a replaced compiler reports again',
	{ skip: process.platform === 'win32' ? 'uses a POSIX shell script as a fake compiler' : false },
	async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coglens-target-'));
		const compiler = path.join(directory, 'gcc');
		const writeCompiler = (triple: string, time: number) => {
			fs.writeFileSync(
				compiler,
				`#!/bin/sh\nif [ -f "$0.ok" ]; then printf '%s\\n' '${triple}'; exit 0; fi\nexit 1\n`,
			);
			fs.chmodSync(compiler, 0o755);
			fs.utimesSync(compiler, time, time);
		};
		const profile = toolchainProfile('gcc', { executable: compiler });
		try {
			writeCompiler('aarch64-linux-gnu', 1_000_000);
			assert.equal(await toolchainTarget(profile), undefined);
			fs.writeFileSync(`${compiler}.ok`, '');
			assert.equal(await toolchainTarget(profile), 'aarch64-linux-gnu', 'The failure is not kept');
			writeCompiler('powerpc64le-linux-gnu', 2_000_000);
			assert.equal(await toolchainTarget(profile), 'powerpc64le-linux-gnu', 'The new compiler reports');
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	},
);
