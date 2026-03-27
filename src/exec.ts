import child_process from 'child_process';

export type ExecResult = {
	returnCode: number,
	stdout: string,
	stderr: string
};

export interface ExecOptions extends child_process.SpawnOptions {
	/** Timeout in milliseconds. Defaults to 60000 (60s). Use 0 for no timeout. */
	timeout?: number;
	/** Maximum combined output size in bytes. Defaults to 50MB. Use 0 for no limit. */
	maxOutputSize?: number;
}

const DEFAULT_TIMEOUT = 60_000;
const DEFAULT_MAX_OUTPUT = 50 * 1024 * 1024;

export function execute(command: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
	const { timeout = DEFAULT_TIMEOUT, maxOutputSize = DEFAULT_MAX_OUTPUT, ...spawnOptions } = options;

	const proc = child_process.spawn(command, args, spawnOptions);

	const stdoutChunks: string[] = [];
	const stderrChunks: string[] = [];
	let totalSize = 0;
	let killed = false;

	const killProcess = (reason: string) => {
		if (!killed) {
			killed = true;
			proc.kill();
			// Fallback SIGKILL after 5s if process doesn't exit
			setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* already dead */ } }, 5000).unref();
		}
	};

	proc.stdout?.on('data', (data: Buffer | string) => {
		const chunk = String(data);
		totalSize += chunk.length;
		if (maxOutputSize > 0 && totalSize > maxOutputSize) {
			killProcess('output size exceeded');
			return;
		}
		stdoutChunks.push(chunk);
	});

	proc.stderr?.on('data', (data: Buffer | string) => {
		const chunk = String(data);
		totalSize += chunk.length;
		if (maxOutputSize > 0 && totalSize > maxOutputSize) {
			killProcess('output size exceeded');
			return;
		}
		stderrChunks.push(chunk);
	});

	return new Promise((resolve, reject) => {
		let timer: ReturnType<typeof setTimeout> | undefined;

		if (timeout > 0) {
			timer = setTimeout(() => {
				killProcess('timeout');
			}, timeout);
		}

		proc.on('error', err => {
			if (timer) { clearTimeout(timer); }
			reject(err);
		});

		proc.on('close', code => {
			if (timer) { clearTimeout(timer); }

			if (killed && code !== 0) {
				if (maxOutputSize > 0 && totalSize > maxOutputSize) {
					reject(new Error(`Process output exceeded ${maxOutputSize} bytes limit`));
					return;
				}
				reject(new Error(`Process timed out after ${timeout}ms`));
				return;
			}

			const result: ExecResult = {
				returnCode: code ?? -1,
				stdout: stdoutChunks.join(''),
				stderr: stderrChunks.join('')
			};

			resolve(result);
		});
	});
}
