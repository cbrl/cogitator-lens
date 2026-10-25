import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { execute, ExecError, type CancellationLike } from '../../src/exec.js';
import { executeTextTool } from '../../src/toolchains/toolchain-backend.js';
import { neverCancelled } from '../support/toolchains.js';

class TestCancellationToken implements CancellationLike {
	private readonly emitter = new EventEmitter();
	isCancellationRequested = false;

	onCancellationRequested(listener: () => void): { dispose(): void } {
		this.emitter.on('cancel', listener);
		return { dispose: () => this.emitter.off('cancel', listener) };
	}

	cancel(): void {
		this.isCancellationRequested = true;
		this.emitter.emit('cancel');
	}
}

test('passes spaces and shell metacharacters as literal argv values', async () => {
	const values = ['value with spaces', '$(echo unsafe)', '& calc.exe', 'semi;colon'];
	const result = await execute(process.execPath, [
		'-e',
		'process.stdout.write(JSON.stringify(process.argv.slice(1)))',
		...values,
	]);
	assert.deepEqual(JSON.parse(result.stdout), values);
});

test('writes and closes child-process stdin', async () => {
	const input = 'assembly with spaces\n_and_symbols\n';
	const echoed = await execute(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { stdin: input });
	const closed = await execute(process.execPath, [
		'-e',
		'process.stdin.on("end", () => process.stdout.write("closed")); process.stdin.resume()',
	]);
	assert.equal(echoed.stdout, input);
	assert.equal(closed.stdout, 'closed');
});

test('measures output limits in bytes', async () => {
	await assert.rejects(
		execute(process.execPath, ['-e', `process.stdout.write('é'.repeat(100))`], { maxOutputBytes: 150 }),
		(error: unknown) => error instanceof ExecError && error.kind === 'output-limit',
	);
});

test('distinguishes timeout and cancellation', async () => {
	await assert.rejects(
		execute(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 25 }),
		(error: unknown) => error instanceof ExecError && error.kind === 'timeout',
	);

	const token = new TestCancellationToken();
	const execution = execute(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
		cancellationToken: token,
		timeoutMs: 5_000,
	});
	setTimeout(() => token.cancel(), 25);
	await assert.rejects(execution, (error: unknown) => error instanceof ExecError && error.kind === 'cancelled');
});

test('rejects after the termination grace period when process termination never closes the child', async () => {
	const originalSpawn = childProcess.spawn;
	const spawned: FakeChildProcess[] = [];
	childProcess.spawn = (() => {
		const child = new FakeChildProcess();
		spawned.push(child);
		return child;
	}) as unknown as typeof childProcess.spawn;
	const keepAlive = setTimeout(() => undefined, 1_000);

	try {
		await assert.rejects(
			execute('unresponsive-process', [], {
				timeoutMs: 5,
				terminationGraceMs: 10,
			}),
			(error: unknown) => error instanceof ExecError && error.kind === 'timeout',
		);
		assert.ok(spawned.length >= 1);
	} finally {
		clearTimeout(keepAlive);
		childProcess.spawn = originalSpawn;
	}
});

class FakeChildProcess extends EventEmitter {
	readonly pid = 2_000_000_000;
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();

	kill(): boolean {
		return true;
	}
}

test('a tool that reads its input from stdin is driven through the shared exec path', async () => {
	const output = await executeTextTool(
		'process.stdout.write("demangled-symbol")',
		{ executable: process.execPath, inputMode: 'stdin' },
		process.env,
		process.cwd(),
		neverCancelled,
	);
	assert.equal(output, 'demangled-symbol');
});

test('a file-argument text tool receives a temporary input path', async () => {
	const output = await executeTextTool(
		'process.stdout.write("file-input")',
		{
			executable: process.execPath,
			inputMode: 'file-argument',
		},
		process.env,
		process.cwd(),
		neverCancelled,
	);
	assert.equal(output, 'file-input');
});

test('a stdout line filter drops lines before they count toward the output limit', async () => {
	// Each line arrives in two writes, and the last line has no line break.
	const script = String.raw`
		for (let index = 0; index < 2000; index++) {
			const keep = index % 100 === 0;
			process.stdout.write(keep ? 'ke' : 'dr');
			process.stdout.write((keep ? 'ep ' : 'op ') + index + '\n');
		}
		process.stdout.write('keep last');
	`;
	const result = await execute(process.execPath, ['-e', script], {
		maxOutputBytes: 1_000,
		stdoutLineFilter: (line) => line.startsWith('keep'),
	});
	assert.equal(result.returnCode, 0);
	const lines = result.stdout.split('\n');
	assert.equal(lines.length, 21);
	assert.equal(lines[1], 'keep 100');
	assert.equal(lines.at(-1), 'keep last');
	await assert.rejects(
		execute(process.execPath, ['-e', script], { maxOutputBytes: 1_000 }),
		(error: unknown) =>
			error instanceof ExecError &&
			error.kind === 'output-limit' &&
			/coglens\.processOutputLimit/.test(error.message),
	);
});
