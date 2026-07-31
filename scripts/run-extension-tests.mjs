import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTests } from '@vscode/test-electron';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

try {
	await runTests({
		version: '1.103.1',
		extensionDevelopmentPath: repositoryRoot,
		extensionTestsPath: path.join(repositoryRoot, 'out', 'test', 'extension', 'runTest.js'),
		launchArgs: [repositoryRoot, '--disable-extensions', '--disable-workspace-trust'],
	});
} catch (error) {
	console.error(error);
	process.exitCode = 1;
}
