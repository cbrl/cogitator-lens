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
	stdin?: string | Buffer;
	/**
	 * Keeps only the stdout lines it accepts, without their line ending. Dropped lines do not count
	 * toward the output limit, so a tool can print more than the limit when most of it is dropped.
	 */
	stdoutLineFilter?: (line: string) => boolean;
}

export interface ProcessLimits {
	readonly timeoutMs: number;
	readonly maxOutputBytes: number;
}

let processLimits: ProcessLimits = { timeoutMs: 60_000, maxOutputBytes: 50 * 1024 * 1024 };
const defaultTerminationGraceMs = 2_000;

/** Sets the limits that processes use unless their options name their own, from user settings. */
export function setProcessLimits(limits: ProcessLimits): void {
	processLimits = limits;
}

export function currentProcessLimits(): ProcessLimits {
	return processLimits;
}

export async function execute(
	command: string,
	args: readonly string[],
	options: ExecOptions = {},
): Promise<ExecResult> {
	const {
		timeoutMs = processLimits.timeoutMs,
		maxOutputBytes = processLimits.maxOutputBytes,
		terminationGraceMs = defaultTerminationGraceMs,
		cancellationToken,
		stdin,
		stdoutLineFilter,
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
				fail('output-limit', outputLimitMessage(maxOutputBytes));
				return;
			}
			target.push(data);
		};

		// A line break never occurs inside a UTF-8 sequence, so lines split safely at byte 10.
		let partialLine: Buffer[] = [];
		let partialLineBytes = 0;
		const acceptLine = (line: Buffer): void => {
			const text = line.toString().replace(/\r?\n$/, '');
			if (stdoutLineFilter?.(text)) {
				append(stdout, line);
			}
		};
		const appendFilteredStdout = (chunk: Buffer | string): void => {
			const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			let start = 0;
			for (let end = data.indexOf(10); end !== -1; end = data.indexOf(10, start)) {
				partialLine.push(data.subarray(start, end + 1));
				acceptLine(Buffer.concat(partialLine));
				partialLine = [];
				partialLineBytes = 0;
				start = end + 1;
			}
			if (start < data.length) {
				partialLine.push(data.subarray(start));
				partialLineBytes += data.length - start;
				if (maxOutputBytes > 0 && partialLineBytes > maxOutputBytes) {
					fail('output-limit', outputLimitMessage(maxOutputBytes));
				}
			}
		};

		process.stdout?.on('data', (chunk) => (stdoutLineFilter ? appendFilteredStdout(chunk) : append(stdout, chunk)));
		process.stderr?.on('data', (chunk) => append(stderr, chunk));
		process.stdin?.on('error', (error) => {
			if ((error as NodeJS.ErrnoException).code !== 'EPIPE') {
				fail('spawn', `Failed to write process input: ${error.message}`);
			}
		});
		process.stdin?.end(stdin);

		timeout =
			timeoutMs > 0
				? setTimeout(
						() =>
							fail(
								'timeout',
								`The process ran longer than ${formatSeconds(timeoutMs)}. Raise coglens.processTimeout to allow more time.`,
							),
						timeoutMs,
					)
				: undefined;
		timeout?.unref();

		cancellation = cancellationToken?.onCancellationRequested(() => {
			fail('cancelled', 'Process execution was cancelled');
		});

		process.once('error', (error) => {
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

		process.once('close', (code) => {
			if (settled) {
				return;
			}
			if (partialLine.length > 0 && !failure) {
				acceptLine(Buffer.concat(partialLine));
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

/** Explains an output limit and the setting that raises it. */
export function outputLimitMessage(maxOutputBytes: number): string {
	return `The process wrote more than ${formatMegabytes(maxOutputBytes)} of output. Raise coglens.processOutputLimit to allow more.`;
}

function formatMegabytes(bytes: number): string {
	const megabytes = bytes / (1024 * 1024);
	return `${Number.isInteger(megabytes) ? megabytes : megabytes.toFixed(1)} MB`;
}

function formatSeconds(milliseconds: number): string {
	const seconds = milliseconds / 1000;
	return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)} s`;
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
