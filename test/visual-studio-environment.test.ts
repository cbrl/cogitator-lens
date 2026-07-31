import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execute } from '../src/exec.js';
import {
	visualStudioDiscoveryArguments,
	visualStudioEnvironmentCandidates,
} from '../src/toolchains/msvc.js';

test('discovers Visual Studio environments for MSVC-compatible compilers', () => {
	for (const [compiler, script] of [
		[
			'C:\\Program Files\\Microsoft Visual Studio\\18\\Insiders\\VC\\Tools\\Llvm\\x64\\bin\\clang-cl.exe',
			'C:\\Program Files\\Microsoft Visual Studio\\18\\Insiders\\VC\\Auxiliary\\Build\\vcvarsall.bat',
		],
		[
			'C:\\Program Files\\Microsoft Visual Studio\\2022\\BuildTools\\VC\\Tools\\MSVC\\14.44.35207\\bin\\Hostx64\\x64\\cl.exe',
			'C:\\Program Files\\Microsoft Visual Studio\\2022\\BuildTools\\VC\\Auxiliary\\Build\\vcvarsall.bat',
		],
	]) {
		assert.deepEqual(visualStudioEnvironmentCandidates(compiler), [script]);
	}
	assert.ok(visualStudioDiscoveryArguments.includes('-prerelease'));
});

test('cmd can call a quoted environment script path verbatim', async context => {
	if (process.platform !== 'win32') {
		context.skip('Windows command-processor behavior is only applicable on Windows.');
		return;
	}
	const commandProcessor = findWindowsCommandProcessor();
	if (!commandProcessor) {
		context.skip('No Windows command processor was found through ComSpec, SystemRoot, or PATH.');
		return;
	}
	const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'coglens quoted path '));
	const script = path.join(directory, 'capture environment.cmd');
	try {
		await fs.promises.writeFile(script, '@echo off\r\necho environment-captured\r\n');
		const result = await execute(commandProcessor, [
			'/d',
			'/s',
			'/c',
			`call "${script}"`,
		], {
			windowsVerbatimArguments: true,
		});
		assert.equal(result.returnCode, 0);
		assert.match(result.stdout, /environment-captured/);
	} finally {
		await fs.promises.rm(directory, { recursive: true, force: true });
	}
});

function findWindowsCommandProcessor(): string | undefined {
	const configured = process.env.ComSpec ?? process.env.COMSPEC;
	const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
	const candidates = [
		configured,
		systemRoot ? path.join(systemRoot, 'System32', 'cmd.exe') : undefined,
		...((process.env.PATH ?? '').split(path.delimiter)
			.filter(Boolean)
			.map(directory => path.join(directory, 'cmd.exe'))),
	];
	return candidates.find((candidate): candidate is string =>
		typeof candidate === 'string' && fs.existsSync(candidate));
}
