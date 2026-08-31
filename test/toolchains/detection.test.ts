import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ResolvedEnvironment } from '@vscode/python-extension';
import {
	createPythonEnvironmentProfiles,
	matchesPythonEnvironment,
	pythonEnvironmentDisplayName,
	pythonEnvironmentVersion,
} from '../../src/buildsystems/python-environment-model.js';
import {
	createToolchainProfile,
	detectToolchainDefinition,
	getToolchainDefinition,
	toolchainDefinitions,
} from '../../src/toolchains/toolchain-map.js';
import { visualStudioDiscoveryArguments, visualStudioEnvironmentCandidates } from '../../src/toolchains/msvc.js';

test('executable names resolve to the toolchain that owns them', () => {
	for (const [executable, expected] of [
		['g++-14', 'gcc'],
		['clang++-19', 'clang'],
		['clang-cl.exe', 'clang-cl'],
		['cl.exe', 'msvc'],
		['rustc', 'rust'],
		['python3.13', 'python'],
		['go.exe', 'go'],
		['zig', 'zig'],
		['nvcc.exe', 'nvcc'],
	] as const) {
		assert.equal(detectToolchainDefinition(executable, '', 'win32')?.kind, expected, executable);
	}
	// Apple's clang only announces itself in its version banner.
	assert.equal(detectToolchainDefinition('clang', 'Apple clang version 17', 'linux')?.kind, 'apple-clang');
	assert.equal(detectToolchainDefinition('not-gcc', '', 'linux'), undefined);
	assert.equal(detectToolchainDefinition('compiler-wrapper', '', 'linux'), undefined);
	assert.ok(toolchainDefinitions.nvcc.languageIdentifiers.includes('cuda-cpp'));
});

test('include and define flags are toolchain-owned, and absent where the concept is', () => {
	assert.deepEqual(
		(['gcc', 'msvc', 'rust', 'python'] as const).map((kind) => {
			const definition = getToolchainDefinition(kind);
			return [definition.includeFlag, definition.defineFlag];
		}),
		[
			['-I', '-D'],
			['/I', '/D'],
			[undefined, '--cfg='],
			[undefined, undefined],
		],
	);
	// Python neither compiles to an object file nor produces parseable assembly.
	assert.equal(getToolchainDefinition('python').outputArguments, undefined);
	assert.equal(getToolchainDefinition('python').createParser, undefined);
});

test('profile creation discovers auxiliary tools beside the compiler and keeps configured ones', () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coglens-tools-'));
	try {
		const named = (name: string) => path.join(directory, process.platform === 'win32' ? `${name}.exe` : name);
		const [executable, demangler, disassembler] = ['gcc', 'c++filt', 'objdump'].map(named);
		for (const file of [executable, demangler, disassembler]) {
			fs.writeFileSync(file, '');
		}
		const detected = createToolchainProfile('gcc', 'Detected GCC', executable, {
			tools: { analyzer: process.execPath },
		});
		assert.deepEqual(detected.tools, { demangler, disassembler, analyzer: process.execPath });
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test('resolved Python environments become deduplicated toolchain profiles', () => {
	const environmentName = '.venv';
	const version = [3, 13, 5] as const;
	const primary = pythonEnvironment({
		id: 'venv-id',
		executable: 'C:\\work\\.venv\\Scripts\\python.exe',
		folder: 'C:\\work\\.venv',
		name: environmentName,
		version,
	});
	const duplicate = pythonEnvironment({
		id: 'duplicate-id',
		executable: 'C:\\work\\.venv\\Scripts\\python.exe',
		folder: 'C:\\work\\.venv',
		version,
	});
	const withoutExecutable = {
		...pythonEnvironment({ id: 'invalid', executable: 'C:\\invalid\\python.exe', version: [3, 12, 0] }),
		executable: { uri: undefined, bitness: '64-bit' as const, sysPrefix: 'C:\\invalid' },
	};

	const profiles = createPythonEnvironmentProfiles([primary, duplicate, withoutExecutable], 'win32');

	assert.equal(profiles.length, 1);
	assert.equal(profiles[0].profile.kind, 'python');
	assert.equal(profiles[0].profile.executable, primary.executable.uri?.fsPath);
	assert.equal(profiles[0].profile.displayName, pythonEnvironmentDisplayName(primary));
	assert.equal(pythonEnvironmentVersion(primary), version.join('.'));
	// The name a user picks from identifies the interpreter version, the
	// environment it belongs to, and the executable it will run.
	for (const part of [version.join('.'), environmentName, primary.executable.uri?.fsPath ?? '']) {
		assert.ok(profiles[0].profile.displayName.includes(part), `display name omits ${part}`);
	}
	// A selection matches by case-insensitive folder path or by environment id.
	assert.ok(matchesPythonEnvironment({ id: 'selection', path: 'c:\\WORK\\.VENV' }, profiles[0], 'win32'));
	assert.ok(matchesPythonEnvironment({ id: 'DUPLICATE-ID', path: 'unused' }, profiles[0], 'win32'));
});

test('Visual Studio environment scripts are derived from the compiler location', () => {
	for (const [compiler, script] of [
		[
			'C:\\Program Files\\Microsoft Visual Studio\\18\\Insiders\\VC\\Tools\\Llvm\\x64\\bin\\clang-cl.exe',
			'C:\\Program Files\\Microsoft Visual Studio\\18\\Insiders\\VC\\Auxiliary\\Build\\vcvarsall.bat',
		],
		[
			'C:\\Program Files\\Microsoft Visual Studio\\2022\\BuildTools\\VC\\Tools\\MSVC\\14.44.35207\\bin\\Hostx64\\x64\\cl.exe',
			'C:\\Program Files\\Microsoft Visual Studio\\2022\\BuildTools\\VC\\Auxiliary\\Build\\vcvarsall.bat',
		],
	]) {
		assert.deepEqual(visualStudioEnvironmentCandidates(compiler), [script]);
	}
	assert.ok(visualStudioDiscoveryArguments.includes('-prerelease'));
});

function pythonEnvironment(options: {
	readonly id: string;
	readonly executable: string;
	readonly folder?: string;
	readonly name?: string;
	readonly version: readonly [number, number, number];
}): ResolvedEnvironment {
	const uri = (fsPath: string) =>
		({ scheme: 'file', fsPath, path: fsPath.replaceAll('\\', '/') }) as NonNullable<
			ResolvedEnvironment['executable']['uri']
		>;
	const folderUri = uri(options.folder ?? options.executable);
	return {
		id: options.id,
		path: options.folder ?? options.executable,
		executable: { uri: uri(options.executable), bitness: '64-bit', sysPrefix: folderUri.fsPath },
		environment: options.folder
			? { type: 'VirtualEnvironment', name: options.name, folderUri, workspaceFolder: undefined }
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
