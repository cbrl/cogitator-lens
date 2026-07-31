import assert from 'node:assert/strict';
import test from 'node:test';
import type { ResolvedEnvironment } from '@vscode/python-extension';
import {
	createPythonEnvironmentProfiles,
	matchesPythonEnvironment,
	pythonEnvironmentDisplayName,
	pythonEnvironmentVersion,
} from '../src/buildsystems/python-environment-model.js';

test('resolved Python environments become deduplicated toolchain profiles', () => {
	const primary = environment({
		id: 'venv-id',
		executable: 'C:\\work\\.venv\\Scripts\\python.exe',
		folder: 'C:\\work\\.venv',
		name: '.venv',
		version: [3, 13, 5],
	});
	const duplicate = environment({
		id: 'duplicate-id',
		executable: 'C:\\work\\.venv\\Scripts\\python.exe',
		folder: 'C:\\work\\.venv',
		name: undefined,
		version: [3, 13, 5],
	});
	const invalid = {
		...environment({
			id: 'invalid',
			executable: 'C:\\invalid\\python.exe',
			version: [3, 12, 0],
		}),
		executable: {
			uri: undefined,
			bitness: '64-bit' as const,
			sysPrefix: 'C:\\invalid',
		},
	};

	const profiles = createPythonEnvironmentProfiles(
		[primary, duplicate, invalid],
		'win32',
	);

	assert.equal(profiles.length, 1);
	assert.equal(profiles[0].profile.kind, 'python');
	assert.equal(profiles[0].profile.executable, primary.executable.uri?.fsPath);
	assert.equal(profiles[0].profile.displayName, pythonEnvironmentDisplayName(primary));
	assert.match(profiles[0].profile.displayName, /Python 3\.13\.5 \(\.venv\)/);
	assert.equal(pythonEnvironmentVersion(primary), '3.13.5');
	assert.ok(matchesPythonEnvironment(
		{ id: 'selection', path: 'c:\\WORK\\.VENV' },
		profiles[0],
		'win32',
	));
	assert.ok(matchesPythonEnvironment(
		{ id: 'DUPLICATE-ID', path: 'unused' },
		profiles[0],
		'win32',
	));
});

function environment(options: {
	readonly id: string;
	readonly executable: string;
	readonly folder?: string;
	readonly name?: string;
	readonly version: readonly [number, number, number];
}): ResolvedEnvironment {
	const executableUri = fileUri(options.executable);
	const folderUri = fileUri(options.folder ?? options.executable);
	return {
		id: options.id,
		path: options.folder ?? options.executable,
		executable: {
			uri: executableUri,
			bitness: '64-bit',
			sysPrefix: folderUri.fsPath,
		},
		environment: options.folder
			? {
				type: 'VirtualEnvironment',
				name: options.name,
				folderUri,
				workspaceFolder: undefined,
			}
			: undefined,
		version: {
			major: options.version[0],
			minor: options.version[1],
			micro: options.version[2],
			release: { level: 'final', serial: 0 },
			sysVersion: options.version.join('.'),
		},
		tools: options.folder ? ['Venv'] : [],
	};
}

function fileUri(fsPath: string): NonNullable<ResolvedEnvironment['executable']['uri']> {
	return {
		scheme: 'file',
		fsPath,
		path: fsPath.replaceAll('\\', '/'),
	} as NonNullable<ResolvedEnvironment['executable']['uri']>;
}
