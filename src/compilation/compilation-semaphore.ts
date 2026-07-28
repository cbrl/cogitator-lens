export interface SemaphoreCancellationToken {
	readonly isCancellationRequested: boolean;
	onCancellationRequested(listener: () => void): { dispose(): void };
}

interface Waiter {
	readonly token: SemaphoreCancellationToken;
	readonly resolve: () => void;
	readonly reject: (error: Error) => void;
	cancellation?: { dispose(): void };
}

/**
 * A cancellation-aware concurrency limiter. A released slot is passed directly
 * to the next live waiter, so cancelled waiters cannot consume capacity.
 */
export class CompilationSemaphore {
	private active = 0;
	private readonly queue: Waiter[] = [];

	constructor(
		private readonly maximumConcurrent: number,
		private readonly createCancellationError: () => Error,
	) {
		if (!Number.isInteger(maximumConcurrent) || maximumConcurrent <= 0) {
			throw new RangeError('maximumConcurrent must be a positive integer');
		}
	}

	acquire(token: SemaphoreCancellationToken): Promise<void> {
		if (token.isCancellationRequested) {
			return Promise.reject(this.createCancellationError());
		}
		if (this.active < this.maximumConcurrent) {
			this.active++;
			return Promise.resolve();
		}

		return new Promise((resolve, reject) => {
			const waiter: Waiter = { token, resolve, reject };
			this.queue.push(waiter);
			waiter.cancellation = token.onCancellationRequested(() => this.cancel(waiter));
			if (token.isCancellationRequested) {
				this.cancel(waiter);
			}
		});
	}

	release(): void {
		if (this.active <= 0) {
			throw new Error('Cannot release an inactive compilation semaphore');
		}

		while (this.queue.length > 0) {
			const waiter = this.queue.shift()!;
			waiter.cancellation?.dispose();
			if (waiter.token.isCancellationRequested) {
				waiter.reject(this.createCancellationError());
				continue;
			}
			waiter.resolve();
			return;
		}

		this.active--;
	}

	private cancel(waiter: Waiter): void {
		const index = this.queue.indexOf(waiter);
		if (index < 0) {
			return;
		}
		this.queue.splice(index, 1);
		waiter.cancellation?.dispose();
		waiter.reject(this.createCancellationError());
	}
}
