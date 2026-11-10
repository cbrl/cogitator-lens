import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
	assembleCargoArguments,
	cargoLlvmIrOutput,
	cargoMessages,
	cargoOptimizationRemarksOutput,
	cargoOutputArguments,
	cargoOutputDirectory,
	cargoRunsFolder,
	localDependencyInfoFiles,
	lockOutputDirectory,
	runCargoInvocation,
	splitCargoArguments,
	stripCargoManagedArguments,
} from '../../src/toolchains/cargo.js';
import { ToolExitError } from '../../src/toolchains/toolchain-backend.js';
import { ExecError, type ExecResult } from '../../src/exec.js';
import { neverCancelled } from '../support/toolchains.js';

const source = path.resolve('crate', 'src', 'geometry.rs');
const variantArguments = [
	'--manifest-path',
	path.resolve('crate', 'Cargo.toml'),
	'--lib',
	'--profile',
	'release',
	'--',
];

test('Cargo reads the arguments before the first --, and rustc reads the arguments after it', () => {
	assert.deepEqual(splitCargoArguments([...variantArguments, '-C', 'opt-level=1']), {
		cargo: variantArguments.slice(0, -1),
		rustc: ['-C', 'opt-level=1'],
	});
	assert.deepEqual(splitCargoArguments(['--lib']), { cargo: ['--lib'], rustc: [] });
});

test('the Cargo backend removes the options that it owns from both parts', () => {
	assert.deepEqual(
		stripCargoManagedArguments(
			[
				'rustc',
				...variantArguments.slice(0, -1),
				'--message-format',
				'short',
				'--color=always',
				'-vv',
				source,
				'--',
				'-C',
				'opt-level=1',
				'--emit=asm',
				'-o',
				'out.s',
				'--error-format=json',
				source,
			],
			source,
		),
		[...variantArguments, '-C', 'opt-level=1'],
	);
	// Without --, each argument is a Cargo option, and the result still ends the Cargo options.
	assert.deepEqual(stripCargoManagedArguments(['--lib'], source), ['--lib', '--']);
});

test('cargo rustc gets the selected target and the output of the artifact, without the source', () => {
	const owned = [...cargoOutputArguments('assembly', 'out.s'), '-C', 'llvm-args=-x86-asm-syntax=intel'];
	assert.deepEqual(assembleCargoArguments(owned, [...variantArguments, '-C', 'opt-level=1'], source), [
		'rustc',
		...variantArguments.slice(0, -1),
		'--color',
		'never',
		'--message-format',
		'json-render-diagnostics',
		'--',
		'-C',
		'opt-level=1',
		'--emit=asm=out.s',
		'-C',
		'debuginfo=1',
		'-C',
		'llvm-args=-x86-asm-syntax=intel',
	]);
	assert.deepEqual(cargoOutputArguments('object', 'out.o'), ['--emit=obj=out.o', '-C', 'debuginfo=1']);
	assert.deepEqual(cargoLlvmIrOutput.arguments('out.ll', 'temporary', []), [
		'--emit=llvm-ir=out.ll',
		'-C',
		'debuginfo=1',
	]);
	// Cargo builds the crate, so the remarks need no output, and rustc keeps the format of Cargo.
	assert.deepEqual(cargoOptimizationRemarksOutput.arguments('', 'temporary', []), [
		'-C',
		'debuginfo=1',
		'-C',
		'remark=all',
	]);
});

test('the JSON messages of Cargo give the dep-info of the local dependencies only', () => {
	const deps = path.resolve('target', 'coglens', 'release', 'deps');
	const message = (packageId: string, name: string, filenames: string[]) =>
		JSON.stringify({ reason: 'compiler-artifact', package_id: packageId, target: { name }, filenames });
	const stdout = [
		message('path+file:///work/util#0.1.0', 'util', [
			path.join(deps, 'libutil-519a8ce5da6ba137.rlib'),
			path.join(deps, 'libutil-519a8ce5da6ba137.rmeta'),
		]),
		message('path+file:///work/macros#0.1.0', 'my-macros', [path.join(deps, 'my_macros-0123456789abcdef.dll')]),
		message('registry+https://github.com/rust-lang/crates.io-index#serde@1.0.0', 'serde', [
			path.join(deps, 'libserde-fedcba9876543210.rlib'),
		]),
		// Cargo copies the output of the selected target without the hash.
		message('path+file:///work/app#0.1.0', 'app', [path.resolve('target', 'coglens', 'release', 'libapp.rlib')]),
		'{"reason":"build-finished","success":true}',
		'not a message',
		'{ broken',
	].join('\n');
	const { messages, text } = cargoMessages(stdout);
	assert.equal(messages.length, 5);
	assert.equal(text, 'not a message\n{ broken');
	assert.deepEqual(localDependencyInfoFiles(messages), [
		path.join(deps, 'util-519a8ce5da6ba137.d'),
		path.join(deps, 'my_macros-0123456789abcdef.d'),
	]);
});

/** A run of the Cargo runner with a fake Cargo, which writes files into the output directory of its arguments. */
async function runWith(
	args: (temporaryDirectory: string) => readonly string[],
	cargo: (args: readonly string[]) => Promise<ExecResult>,
): Promise<{ readonly result: ExecResult; readonly files: Readonly<Record<string, string>> }> {
	const temporary = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'coglens-cargo-run-'));
	try {
		const result = await runCargoInvocation({
			arguments: args(temporary),
			temporaryDirectory: temporary,
			execute: cargo,
			log: () => undefined,
			cancellationToken: neverCancelled,
		});
		const names = (await fs.promises.readdir(temporary)).sort();
		const files = Object.fromEntries(
			await Promise.all(
				names.map(
					async (name) => [name, await fs.promises.readFile(path.join(temporary, name), 'utf8')] as const,
				),
			),
		);
		return { result, files };
	} finally {
		await fs.promises.rm(temporary, { recursive: true, force: true });
	}
}

/** A compiler-artifact message of a local package. */
function localArtifact(name: string, filename: string): string {
	return JSON.stringify({
		reason: 'compiler-artifact',
		package_id: `path+file:///work/${name}#0.1.0`,
		target: { name },
		filenames: [filename],
	});
}

/** The output directory that the arguments of a run name, after the runner replaced the temporary directory. */
function outputDirectoryOf(args: readonly string[]): string {
	const emit = args.find((argument) => argument.startsWith('--emit=asm='));
	assert.ok(emit);
	return path.dirname(emit.slice('--emit=asm='.length));
}

test('each run of the same arguments writes the outputs to the same directory, and gets them back', async () => {
	const outputs = (temporary: string) => [
		'rustc',
		'--lib',
		'--',
		`--emit=asm=${path.join(temporary, 'output.asm')}`,
		`--emit=dep-info=${path.join(temporary, 'dependencies.d')}`,
	];
	const deps = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'coglens-cargo-deps-'));
	const directories: string[] = [];
	try {
		await fs.promises.writeFile(path.join(deps, 'util-519a8ce5da6ba137.d'), 'libutil.rlib: util/src/lib.rs\n');
		for (let run = 0; run < 2; run++) {
			const { result, files } = await runWith(outputs, async (args) => {
				const directory = outputDirectoryOf(args);
				directories.push(directory);
				await fs.promises.writeFile(path.join(directory, 'output.asm'), `run ${run}`);
				await fs.promises.writeFile(path.join(directory, 'dependencies.d'), 'output.asm: app/src/lib.rs\n');
				const util = localArtifact('util', path.join(deps, 'libutil-519a8ce5da6ba137.rlib'));
				return { returnCode: 0, stdout: `${util}\nplain`, stderr: 'warning' };
			});
			// The dep-info of the target also lists the files of the local dependency.
			assert.deepEqual(files, {
				'dependencies.d': 'output.asm: app/src/lib.rs\n\nlibutil.rlib: util/src/lib.rs\n',
				'output.asm': `run ${run}`,
			});
			assert.deepEqual(result, { returnCode: 0, stdout: 'plain', stderr: 'warning' });
			// The output directory is gone after the run, so no output of a run stays for the next one.
			assert.equal(fs.existsSync(directories[run]), false);
		}
	} finally {
		await fs.promises.rm(deps, { recursive: true, force: true });
	}
	assert.equal(directories[0], directories[1]);
	assert.notEqual(directories[0], cargoOutputDirectory(['rustc', '--bin', 'other'], os.tmpdir()));
	// Each user has a folder of its own, because Linux users share the temporary folder.
	assert.equal(path.dirname(directories[0]), cargoRunsFolder());
	assert.match(path.basename(cargoRunsFolder()), /^coglens-cargo-.+/u);
	if (process.platform !== 'win32') {
		assert.equal((await fs.promises.stat(cargoRunsFolder())).mode & 0o777, 0o700);
	}
});

test('a run waits for the lock of another process, and takes the lock of a process that stopped', async () => {
	const args = (temporary: string) => [
		'rustc',
		'--lib',
		'lock-test',
		'--',
		`--emit=asm=${path.join(temporary, 'a.s')}`,
	];
	const directory = cargoOutputDirectory(args(os.tmpdir()), os.tmpdir());
	const lockFile = `${directory}.lock`;
	await fs.promises.mkdir(path.dirname(directory), { recursive: true });
	const cargo = async (runArguments: readonly string[]) => {
		await fs.promises.writeFile(path.join(outputDirectoryOf(runArguments), 'a.s'), 'code');
		return { returnCode: 0, stdout: '', stderr: '' };
	};
	try {
		// The test runner is a process that runs, so its lock stays until it frees it.
		await fs.promises.writeFile(lockFile, String(process.ppid));
		let started = 0;
		const run = runWith(args, async (runArguments) => {
			started = Date.now();
			return cargo(runArguments);
		});
		await new Promise((resolve) => setTimeout(resolve, 300));
		assert.equal(started, 0, 'The run waits while the other process has the lock');
		const freed = Date.now();
		await fs.promises.rm(lockFile);
		assert.deepEqual((await run).files, { 'a.s': 'code' });
		assert.ok(started >= freed);
		assert.equal(fs.existsSync(lockFile), false, 'The run frees its lock');

		// A process that stopped does not free its lock, and the next run takes it.
		const stopped = childProcess.spawnSync(process.execPath, ['-e', '']).pid;
		await fs.promises.writeFile(lockFile, String(stopped));
		assert.deepEqual((await runWith(args, cargo)).files, { 'a.s': 'code' });
		assert.equal(fs.existsSync(lockFile), false);

		// A cancelled request stops waiting.
		await fs.promises.writeFile(lockFile, String(process.ppid));
		const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) };
		setTimeout(() => (token.isCancellationRequested = true), 150);
		await assert.rejects(
			lockOutputDirectory(directory, token as never),
			(error: unknown) => error instanceof ExecError && error.kind === 'cancelled',
		);
	} finally {
		await fs.promises.rm(lockFile, { force: true });
	}
});

test('a failed run removes the JSON messages from its output, and the next run starts clean', async () => {
	const args = (temporary: string) => ['rustc', '--', `--emit=asm=${path.join(temporary, 'output.asm')}`];
	let directory = '';
	await assert.rejects(
		runWith(args, async (runArguments) => {
			directory = outputDirectoryOf(runArguments);
			await fs.promises.writeFile(path.join(directory, 'stale.asm'), 'partial');
			throw new ToolExitError(
				'Toolchain exited with code 101',
				101,
				'{"reason":"build-finished"}\nplain',
				'error',
			);
		}),
		(error: unknown) => error instanceof ToolExitError && error.stdout === 'plain' && error.stderr === 'error',
	);
	assert.equal(fs.existsSync(directory), false);
	// A file that a crashed run left in the directory does not reach the next run.
	await fs.promises.mkdir(directory, { recursive: true });
	await fs.promises.writeFile(path.join(directory, 'stale.asm'), 'partial');
	const { files } = await runWith(args, async (runArguments) => {
		await fs.promises.writeFile(path.join(outputDirectoryOf(runArguments), 'output.asm'), 'code');
		return { returnCode: 0, stdout: '', stderr: '' };
	});
	assert.deepEqual(files, { 'output.asm': 'code' });
});

test('the runs of the same arguments wait for each other', async () => {
	const args = (temporary: string) => ['rustc', '--', `--emit=asm=${path.join(temporary, 'output.asm')}`];
	const events: string[] = [];
	let running = 0;
	const cargo = (name: string) => async (runArguments: readonly string[]) => {
		running++;
		events.push(`${name} starts with ${running} running`);
		await new Promise((resolve) => setTimeout(resolve, 20));
		await fs.promises.writeFile(path.join(outputDirectoryOf(runArguments), 'output.asm'), name);
		running--;
		return { returnCode: 0, stdout: '', stderr: '' };
	};
	await Promise.all([runWith(args, cargo('first')), runWith(args, cargo('second'))]);
	// Either run can start first, but the second starts only after the first ends.
	assert.deepEqual([...events].sort(), ['first starts with 1 running', 'second starts with 1 running']);
});
