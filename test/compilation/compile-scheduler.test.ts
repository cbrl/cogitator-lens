import assert from 'node:assert/strict';
import test from 'node:test';
import type { CancellationToken } from 'vscode';
import { CompileScheduler, type FlightContext, type FlightTags } from '../../src/compilation/compile-scheduler.js';
import { ExecError } from '../../src/exec.js';
import type { InvocationDetails } from '../../src/types/index.js';

const tags: FlightTags = { source: 'main.cpp', toolchainProfileId: 'gcc' };

/** A token that a test cancels. */
function tokenSource(): { readonly token: CancellationToken; cancel(): void } {
	const listeners = new Set<() => void>();
	const token = {
		isCancellationRequested: false,
		onCancellationRequested: (listener: () => void) => {
			listeners.add(listener);
			return { dispose: () => listeners.delete(listener) };
		},
	};
	return {
		token: token as unknown as CancellationToken,
		cancel() {
			token.isCancellationRequested = true;
			[...listeners].forEach((listener) => listener());
		},
	};
}

/** Work that ends when the test says so, and records each start. */
function controlledWork<T>() {
	const starts: FlightContext[] = [];
	const endings: ((value: T) => void)[] = [];
	const failures: ((error: unknown) => void)[] = [];
	const work = (context: FlightContext): Promise<T> => {
		starts.push(context);
		return new Promise<T>((resolve, reject) => {
			endings.push(resolve);
			failures.push(reject);
			context.cancellationToken.onCancellationRequested(() => reject(new ExecError('cancelled', 'stopped')));
		});
	};
	return { work, starts, endings, failures };
}

const invocation = (executable: string): InvocationDetails => ({
	executable,
	args: [],
	cwd: '/project',
	environmentVariableNames: [],
});

/** Lets the promise reactions run. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('requests for the same key share one compile', async () => {
	const scheduler = new CompileScheduler(4);
	const { work, starts, endings } = controlledWork<string>();
	const first = scheduler.run('key', tags, work, tokenSource().token);
	const second = scheduler.run('key', tags, work, tokenSource().token);
	await settle();
	assert.equal(starts.length, 1);
	assert.equal(scheduler.waitersOf('key'), 2);
	endings[0]('listing');
	assert.deepEqual(await Promise.all([first, second]), ['listing', 'listing']);
	assert.equal(scheduler.size, 0);
});

test('a cancelled request leaves, and the compile continues for the other request', async () => {
	const scheduler = new CompileScheduler(4);
	const { work, starts, endings } = controlledWork<string>();
	const leaving = tokenSource();
	const first = scheduler.run('key', tags, work, leaving.token);
	const second = scheduler.run('key', tags, work, tokenSource().token);
	await settle();
	leaving.cancel();
	await assert.rejects(first, (error: unknown) => error instanceof ExecError && error.kind === 'cancelled');
	assert.equal(starts[0].cancellationToken.isCancellationRequested, false);
	assert.equal(scheduler.waitersOf('key'), 1);
	endings[0]('listing');
	assert.equal(await second, 'listing');
});

test('the last request to leave cancels the compile and removes it at once', async () => {
	const scheduler = new CompileScheduler(4);
	const { work, starts, endings } = controlledWork<string>();
	const only = tokenSource();
	const first = scheduler.run('key', tags, work, only.token);
	await settle();
	only.cancel();
	// A request that comes before the cancelled work ends must not join it.
	assert.equal(scheduler.size, 0);
	assert.equal(starts[0].cancellationToken.isCancellationRequested, true);
	assert.equal(starts[0].isCurrent(), false);
	await assert.rejects(first);
	const next = scheduler.run('key', tags, work, tokenSource().token);
	await settle();
	assert.equal(starts.length, 2);
	endings[1]('new listing');
	assert.equal(await next, 'new listing');
});

test('each request gets the latest command, also when it joins later', async () => {
	const scheduler = new CompileScheduler(4);
	const { work, starts, endings } = controlledWork<string>();
	const seenByFirst: string[] = [];
	const seenBySecond: string[] = [];
	const first = scheduler.run('key', tags, work, tokenSource().token, (details) =>
		seenByFirst.push(details.executable),
	);
	await settle();
	starts[0].onInvocation(invocation('gcc'));
	const second = scheduler.run('key', tags, work, tokenSource().token, (details) =>
		seenBySecond.push(details.executable),
	);
	starts[0].onInvocation(invocation('objdump'));
	endings[0]('listing');
	await Promise.all([first, second]);
	assert.deepEqual(seenByFirst, ['gcc', 'objdump']);
	assert.deepEqual(seenBySecond, ['gcc', 'objdump']);
});

test('compiles over the limit wait in order, and a cancelled one leaves the queue', async () => {
	const scheduler = new CompileScheduler(1);
	const { work, starts, endings } = controlledWork<string>();
	const first = scheduler.run('first', tags, work, tokenSource().token);
	const waiting = tokenSource();
	const second = scheduler.run('second', tags, work, waiting.token);
	const third = scheduler.run('third', tags, work, tokenSource().token);
	await settle();
	assert.equal(starts.length, 1);
	waiting.cancel();
	await assert.rejects(second);
	endings[0]('one');
	assert.equal(await first, 'one');
	await settle();
	// The cancelled compile never started, so the third one is next.
	assert.equal(starts.length, 2);
	endings[1]('three');
	assert.equal(await third, 'three');
	const fourth = scheduler.run('fourth', tags, work, tokenSource().token);
	await settle();
	assert.equal(starts.length, 3);
	endings[2]('four');
	assert.equal(await fourth, 'four');
});

test('a dropped compile still answers its requests, but a new request starts another', async () => {
	const scheduler = new CompileScheduler(4);
	const { work, starts, endings } = controlledWork<string>();
	const first = scheduler.run('key', tags, work, tokenSource().token);
	await settle();
	scheduler.drop((flightTags) => flightTags.source === 'main.cpp');
	assert.equal(starts[0].isCurrent(), false);
	assert.equal(starts[0].cancellationToken.isCancellationRequested, false);
	const second = scheduler.run('key', tags, work, tokenSource().token);
	await settle();
	assert.equal(starts.length, 2);
	assert.equal(starts[1].isCurrent(), true);
	endings[0]('old');
	endings[1]('new');
	assert.equal(await first, 'old');
	assert.equal(await second, 'new');
	assert.equal(scheduler.size, 0);
});

test('drop leaves the compiles of other sources', async () => {
	const scheduler = new CompileScheduler(4);
	const { work, starts, endings } = controlledWork<string>();
	const other = scheduler.run('key', { source: 'other.cpp', toolchainProfileId: 'gcc' }, work, tokenSource().token);
	await settle();
	scheduler.drop((flightTags) => flightTags.toolchainProfileId === 'clang');
	assert.equal(starts[0].isCurrent(), true);
	endings[0]('kept');
	assert.equal(await other, 'kept');
});

test('a failed compile fails each request', async () => {
	const scheduler = new CompileScheduler(4);
	const { work, failures } = controlledWork<string>();
	const first = scheduler.run('key', tags, work, tokenSource().token);
	const second = scheduler.run('key', tags, work, tokenSource().token);
	await settle();
	failures[0](new Error('exit 1'));
	await assert.rejects(first, /exit 1/);
	await assert.rejects(second, /exit 1/);
	assert.equal(scheduler.size, 0);
});

test('a request with a cancelled token starts nothing', async () => {
	const scheduler = new CompileScheduler(4);
	const { work, starts } = controlledWork<string>();
	const cancelled = tokenSource();
	cancelled.cancel();
	await assert.rejects(scheduler.run('key', tags, work, cancelled.token));
	await settle();
	assert.equal(starts.length, 0);
	assert.equal(scheduler.size, 0);
});
