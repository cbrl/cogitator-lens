import fs from 'fs';
import os from 'os';
import path from 'path';

export async function withTemporaryDirectory<T>(
	prefix: string,
	action: (directory: string) => Promise<T>,
): Promise<T> {
	const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
	try {
		return await action(directory);
	} finally {
		await fs.promises.rm(directory, { recursive: true, force: true });
	}
}
