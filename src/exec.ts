import child_process from 'child_process';

export type ExecResult = {
	returnCode: number,
	stdout: string,
	stderr: string
};

export function execute(command: string, args: string[], options: child_process.SpawnOptions): Promise<ExecResult> {
	const process = child_process.spawn(command, args, options);

	const streams = {
		stdout: '',
		stderr: ''
	};

	process.stdout?.on('data', data => {
		streams.stdout += data;
	});

	process.stderr?.on('data', data => {
		streams.stderr += data;
	});

	return new Promise((resolve, reject) => {
		process.on('error', err => {
			reject(err);
		});

		process.on('close', code => {
			if (code === null) {
				code = -1;
			}

			const result: ExecResult = {
				returnCode: code,
				stdout: streams.stdout,
				stderr: streams.stderr
			};

			resolve(result);
		});
	});
}
