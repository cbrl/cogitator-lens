import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { execute, ExecError, type CancellationLike } from '../src/exec.js';

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
	const echoed = await execute(process.execPath, [
		'-e',
		'process.stdin.pipe(process.stdout)',
	], { stdin: input });
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
	await assert.rejects(
		execution,
		(error: unknown) => error instanceof ExecError && error.kind === 'cancelled',
	);
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
