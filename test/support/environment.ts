import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { TestContext } from 'node:test';

export const repositoryRoot = path.resolve(__dirname, '..', '..');

/** Absolute path to a checked-in fixture, independent of the working directory. */
export function fixturePath(...segments: readonly string[]): string {
	return path.join(repositoryRoot, 'test', 'fixtures', ...segments);
}

export function readFixture(...segments: readonly string[]): string {
	return fs.readFileSync(fixturePath(...segments), 'utf8');
}

export function commandExists(command: string, versionFlag = '--version'): boolean {
	return childProcess.spawnSync(command, [versionFlag], { stdio: 'ignore', windowsHide: true }).status === 0;
}

/**
 * Skips the running test when a tool is absent.
 *
 * Integration probes exercise real compilers, so they have to stay optional
 * without silently reporting success on a machine that lacks the toolchain.
 */
export function requireCommand(t: TestContext, command: string, versionFlag = '--version'): boolean {
	if (commandExists(command, versionFlag)) {
		return true;
	}
	t.skip(`${command} is not installed`);
	return false;
}

/** Runs a compiler-like tool and asserts nothing; callers inspect the result. */
export function run(command: string, args: readonly string[]): childProcess.SpawnSyncReturns<string> {
	return childProcess.spawnSync(command, [...args], { encoding: 'utf8', windowsHide: true });
}
