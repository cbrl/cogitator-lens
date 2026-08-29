import fs from 'fs';
import os from 'os';
import path from 'path';

export async function withTemporaryDirectory<T>(
	prefix: string,
	action: (directory: string) => Promise<T>,
): Promise<T> {
	const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
	let actionError: unknown;
	try {
		return await action(directory);
	} catch (error) {
		actionError = error;
		throw error;
	} finally {
		try {
			await fs.promises.rm(directory, {
				recursive: true,
				force: true,
				maxRetries: 4,
				retryDelay: 50,
			});
		} catch (cleanupError) {
			// A lingering compiler descendant on Windows must not replace the
			// cancellation, timeout, or compiler error that prompted cleanup.
			if (actionError === undefined) {
				throw cleanupError;
			}
		}
	}
}
