import os from 'node:os';
import type { CancellationToken, Disposable } from 'vscode';
import { ExecError } from '../exec.js';
import type { InvocationDetails } from '../types/index.js';

/** What a flight tells its work. */
export interface FlightContext {
	/** Cancelled when no request waits for the flight any more. */
	readonly cancellationToken: CancellationToken;
	/** Sends the command to each request that waits, and to each request that joins later. */
	readonly onInvocation: (details: InvocationDetails) => void;
	/**
	 * False after the flight was dropped. The output of a dropped flight can be stale, so the work
	 * must not keep it for later requests.
	 */
	readonly isCurrent: () => boolean;
}

/** What a flight is for, so that a change can drop the flights that it affects. */
export interface FlightTags {
	/** The comparison key of the source. */
	readonly source: string;
	readonly toolchainProfileId: string;
}

interface Flight {
	readonly key: string;
	readonly tags: FlightTags;
	readonly cancellation: CancellationSource;
	readonly observers: Set<(details: InvocationDetails) => void>;
	promise: Promise<unknown>;
	waiters: number;
	invocation?: InvocationDetails;
	dropped: boolean;
	settled: boolean;
	/** Set while the flight waits for a slot. */
	queued?: { readonly start: () => void; readonly abandon: () => void };
	running: boolean;
}

/** The number of flights that run at the same time when nothing else is set. */
export function defaultFlightLimit(): number {
	const cores = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
	return Math.max(2, Math.floor(cores / 2));
}

/**
 * Runs each compile once for all the requests that need its output.
 *
 * Requests with the same key share one flight. Each request waits with its own cancellation
 * token. When the last request leaves, the flight is cancelled and removed at once, so no new
 * request joins it. A limited number of flights run at the same time, and the others wait in
 * order. A cancelled flight leaves the queue.
 */
export class CompileScheduler {
	private readonly flights = new Map<string, Flight>();
	private readonly queue: Flight[] = [];
	private running = 0;

	constructor(private readonly limit = defaultFlightLimit()) {}

	/** The number of flights that run or wait for a slot. */
	get size(): number {
		return this.flights.size;
	}

	/** The number of requests that wait for the flight of a key. */
	waitersOf(key: string): number {
		return this.flights.get(key)?.waiters ?? 0;
	}

	/**
	 * Joins the flight of a key, or starts one with the work. The result is the output of the
	 * work. Cancellation of the token rejects with an `ExecError` of kind `cancelled`.
	 */
	run<T>(
		key: string,
		tags: FlightTags,
		work: (context: FlightContext) => Promise<T>,
		cancellationToken: CancellationToken,
		onInvocation?: (details: InvocationDetails) => void,
	): Promise<T> {
		if (cancellationToken.isCancellationRequested) {
			return Promise.reject(cancelledError());
		}
		const flight = this.flights.get(key) ?? this.start(key, tags, work);
		return this.wait(flight, cancellationToken, onInvocation) as Promise<T>;
	}

	/**
	 * Removes the flights that a change makes stale. Their requests still get their output, but a
	 * new request starts a new flight, and the output of a dropped flight is not kept.
	 */
	drop(predicate: (tags: FlightTags) => boolean): void {
		for (const [key, flight] of this.flights) {
			if (predicate(flight.tags)) {
				flight.dropped = true;
				this.flights.delete(key);
			}
		}
	}

	private start(key: string, tags: FlightTags, work: (context: FlightContext) => Promise<unknown>): Flight {
		const flight: Flight = {
			key,
			tags,
			cancellation: new CancellationSource(),
			observers: new Set(),
			promise: Promise.resolve(),
			waiters: 0,
			dropped: false,
			settled: false,
			running: false,
		};
		const context: FlightContext = {
			cancellationToken: flight.cancellation.token,
			onInvocation: (details) => {
				flight.invocation = details;
				for (const observer of [...flight.observers]) {
					observer(details);
				}
			},
			isCurrent: () => !flight.dropped,
		};
		flight.promise = this.acquire(flight)
			.then(() => work(context))
			.finally(() => this.settle(flight));
		// A flight that nobody waits for any more still rejects.
		flight.promise.catch(() => undefined);
		this.flights.set(key, flight);
		return flight;
	}

	private wait(
		flight: Flight,
		cancellationToken: CancellationToken,
		onInvocation: ((details: InvocationDetails) => void) | undefined,
	): Promise<unknown> {
		flight.waiters++;
		if (onInvocation) {
			flight.observers.add(onInvocation);
			if (flight.invocation) {
				onInvocation(flight.invocation);
			}
		}
		return new Promise((resolve, reject) => {
			let subscription: Disposable | undefined;
			let left = false;
			const leave = (): void => {
				if (left) {
					return;
				}
				left = true;
				subscription?.dispose();
				if (onInvocation) {
					flight.observers.delete(onInvocation);
				}
				flight.waiters--;
				if (flight.waiters === 0 && !flight.settled) {
					this.abandon(flight);
				}
			};
			subscription = cancellationToken.onCancellationRequested(() => {
				leave();
				reject(cancelledError());
			});
			flight.promise.then(
				(value) => {
					leave();
					resolve(value);
				},
				(error: unknown) => {
					leave();
					reject(error);
				},
			);
		});
	}

	/** Cancels a flight that no request waits for, and removes it at once. */
	private abandon(flight: Flight): void {
		if (this.flights.get(flight.key) === flight) {
			this.flights.delete(flight.key);
		}
		flight.dropped = true;
		flight.queued?.abandon();
		flight.cancellation.cancel();
	}

	private acquire(flight: Flight): Promise<void> {
		if (this.running < this.limit) {
			this.running++;
			flight.running = true;
			return Promise.resolve();
		}
		return new Promise<void>((resolve, reject) => {
			flight.queued = {
				start: () => {
					flight.queued = undefined;
					flight.running = true;
					resolve();
				},
				abandon: () => {
					flight.queued = undefined;
					const index = this.queue.indexOf(flight);
					if (index >= 0) {
						this.queue.splice(index, 1);
					}
					reject(cancelledError());
				},
			};
			this.queue.push(flight);
		});
	}

	private settle(flight: Flight): void {
		flight.settled = true;
		if (this.flights.get(flight.key) === flight) {
			this.flights.delete(flight.key);
		}
		if (!flight.running) {
			return;
		}
		flight.running = false;
		const next = this.queue.shift();
		if (next) {
			next.queued?.start();
		} else {
			this.running--;
		}
	}
}

function cancelledError(): ExecError {
	return new ExecError('cancelled', 'The compile was cancelled');
}

/** A cancellation source that does not need the VS Code API, so unit tests can run the scheduler. */
class CancellationSource {
	private readonly listeners = new Set<() => void>();
	private cancelled = false;

	readonly token: CancellationToken = {
		isCancellationRequested: false,
		onCancellationRequested: (listener: (event: unknown) => unknown) => {
			if (this.cancelled) {
				queueMicrotask(() => listener(undefined));
				return { dispose: () => undefined };
			}
			const wrapped = (): void => void listener(undefined);
			this.listeners.add(wrapped);
			return { dispose: () => this.listeners.delete(wrapped) };
		},
	};

	cancel(): void {
		if (this.cancelled) {
			return;
		}
		this.cancelled = true;
		(this.token as { isCancellationRequested: boolean }).isCancellationRequested = true;
		for (const listener of [...this.listeners]) {
			listener();
		}
		this.listeners.clear();
	}
}
