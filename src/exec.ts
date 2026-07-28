import childProcess, { type SpawnOptions } from 'child_process';

export type ExecFailureKind = 'cancelled' | 'timeout' | 'output-limit' | 'spawn';

export class ExecError extends Error {
	constructor(
		public readonly kind: ExecFailureKind,
		message: string,
		public readonly stdout = '',
		public readonly stderr = '',
	) {
		super(message);
		this.name = 'ExecError';
	}
}

export interface CancellationLike {
	readonly isCancellationRequested: boolean;
	onCancellationRequested(listener: () => void): { dispose(): void };
}

export interface ExecResult {
	returnCode: number;
	stdout: string;
	stderr: string;
}

export interface ExecOptions extends Omit<SpawnOptions, 'shell'> {
	timeoutMs?: number;
	maxOutputBytes?: number;
	terminationGraceMs?: number;
	cancellationToken?: CancellationLike;
}

const defaultTimeoutMs = 60_000;
const defaultMaxOutputBytes = 50 * 1024 * 1024;
const defaultTerminationGraceMs = 2_000;

export async function execute(command: string, args: readonly string[], options: ExecOptions = {}): Promise<ExecResult> {
	const {
		timeoutMs = defaultTimeoutMs,
		maxOutputBytes = defaultMaxOutputBytes,
		terminationGraceMs = defaultTerminationGraceMs,
		cancellationToken,
		...spawnOptions
	} = options;

	if (cancellationToken?.isCancellationRequested) {
		throw new ExecError('cancelled', 'Process execution was cancelled before it started');
	}

	return new Promise<ExecResult>((resolve, reject) => {
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let outputBytes = 0;
		let failure: ExecError | undefined;
		let settled = false;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		let terminationGrace: ReturnType<typeof setTimeout> | undefined;
		let cancellation: { dispose(): void } | undefined;

		const process = childProcess.spawn(command, [...args], {
			...spawnOptions,
			detached: processPlatformSupportsGroups(),
			shell: false,
			windowsHide: true,
		});

		const finish = (): void => {
			if (timeout) {
				clearTimeout(timeout);
			}
			if (terminationGrace) {
				clearTimeout(terminationGrace);
			}
			cancellation?.dispose();
		};

		const rejectFailure = (): void => {
			if (settled || !failure) {
				return;
			}
			settled = true;
			finish();
			reject(failure);
		};

		const fail = (kind: ExecFailureKind, message: string): void => {
			if (failure || settled) {
				return;
			}
			failure = new ExecError(kind, message, Buffer.concat(stdout).toString(), Buffer.concat(stderr).toString());
			terminationGrace = setTimeout(rejectFailure, Math.max(0, terminationGraceMs));
			terminationGrace.unref();
			try {
				killProcessTree(process);
			} catch {
				process.kill();
			}
		};

		const append = (target: Buffer[], chunk: Buffer | string): void => {
			const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			outputBytes += data.byteLength;
			if (maxOutputBytes > 0 && outputBytes > maxOutputBytes) {
				fail('output-limit', `Process output exceeded the ${maxOutputBytes} byte limit`);
				return;
			}
			target.push(data);
		};

		process.stdout?.on('data', chunk => append(stdout, chunk));
		process.stderr?.on('data', chunk => append(stderr, chunk));

		timeout = timeoutMs > 0
			? setTimeout(() => fail('timeout', `Process timed out after ${timeoutMs} ms`), timeoutMs)
			: undefined;
		timeout?.unref();

		cancellation = cancellationToken?.onCancellationRequested(() => {
			fail('cancelled', 'Process execution was cancelled');
		});

		process.once('error', error => {
			if (settled) {
				return;
			}
			if (failure) {
				rejectFailure();
				return;
			}
			settled = true;
			finish();
			reject(new ExecError('spawn', `Failed to start "${command}": ${error.message}`));
		});

		process.once('close', code => {
			if (settled) {
				return;
			}
			settled = true;
			finish();
			if (failure) {
				reject(failure);
				return;
			}
			resolve({
				returnCode: code ?? -1,
				stdout: Buffer.concat(stdout).toString(),
				stderr: Buffer.concat(stderr).toString(),
			});
		});
	});
}

function processPlatformSupportsGroups(): boolean {
	return process.platform !== 'win32';
}

function killProcessTree(processToKill: childProcess.ChildProcess): void {
	if (!processToKill.pid) {
		return;
	}

	if (process.platform === 'win32') {
		const killer = childProcess.spawn('taskkill.exe', ['/pid', String(processToKill.pid), '/t', '/f'], {
			shell: false,
			windowsHide: true,
			stdio: 'ignore',
		});
		killer.on('error', () => processToKill.kill());
		return;
	}

	try {
		globalThis.process.kill(-processToKill.pid, 'SIGKILL');
	} catch {
		processToKill.kill('SIGKILL');
	}
}
