import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { parseCompilationDatabase } from '../../src/buildsystems/compilation-database-parser.js';

test('parses arguments entries, resolves relative files, and preserves producer-owned arguments', () => {
	const databasePath = path.resolve('workspace', 'build', 'compile_commands.json');
	const directory = path.dirname(databasePath);
	const entries = parseCompilationDatabase(
		JSON.stringify([
			{
				directory,
				file: path.join('..', 'src', 'main.cpp'),
				command: 'unsupported-compiler --ignored-because-arguments-take-precedence',
				arguments: ['g++', '-O2', '-c', path.join('..', 'src', 'main.cpp'), '-o', 'main.o'],
				output: 'main.o',
			},
		]),
		databasePath,
	);

	assert.equal(entries.length, 1);
	assert.equal(entries[0].sourceFile, path.resolve(directory, '..', 'src', 'main.cpp'));
	assert.deepEqual(entries[0].arguments, ['-O2', '-c', '-o', 'main.o']);
	assert.equal(entries[0].workingDirectory, directory);
	assert.equal(entries[0].output, 'main.o');
	assert.equal(entries[0].toolchainProfile.kind, 'gcc');
});

test('discovers Rust variants without rewriting project-specific rustc arguments', () => {
	const databasePath = path.resolve('workspace', 'rust-project', 'compile_commands.json');
	const directory = path.dirname(databasePath);
	const source = path.join(directory, 'src', 'lib.rs');
	const entries = parseCompilationDatabase(
		JSON.stringify([
			{
				directory,
				file: source,
				arguments: [
					'rustc',
					'--crate-name',
					'example',
					'--crate-type=lib',
					'--edition=2021',
					'--extern',
					`dependency=${path.join(directory, 'dependency.rlib')}`,
					'--emit=metadata,link',
					source,
					'-o',
					path.join(directory, 'example.rlib'),
				],
			},
		]),
		databasePath,
	);

	assert.equal(entries.length, 1);
	assert.equal(entries[0].toolchainProfile.kind, 'rust');
	assert.deepEqual(entries[0].arguments, [
		'--crate-name',
		'example',
		'--crate-type=lib',
		'--edition=2021',
		'--extern',
		`dependency=${path.join(directory, 'dependency.rlib')}`,
		'--emit=metadata,link',
		'-o',
		path.join(directory, 'example.rlib'),
	]);
});

test('tokenizes command entries according to the target platform', () => {
	const databasePath = path.resolve('compile_commands.json');
	const posixEntries = parseCompilationDatabase(
		JSON.stringify([
			{
				directory: path.dirname(databasePath),
				file: 'main file.cpp',
				command: `clang++ -DNAME='hello world' -c "main file.cpp" -o main.o`,
			},
		]),
		databasePath,
		'linux',
	);
	const windowsEntries = parseCompilationDatabase(
		JSON.stringify([
			{
				directory: path.dirname(databasePath),
				file: 'main file.cpp',
				command: String.raw`clang-cl.exe /DNAME="hello world" /c "main file.cpp" /Fomain.obj`,
			},
		]),
		databasePath,
		'win32',
	);

	assert.deepEqual(posixEntries[0].arguments, ['-DNAME=hello world', '-c', '-o', 'main.o']);
	assert.equal(windowsEntries[0].toolchainProfile.kind, 'clang-cl');
	assert.deepEqual(windowsEntries[0].arguments, ['/DNAME=hello world', '/c', '/Fomain.obj']);
});

test('logs and skips malformed databases and entries', () => {
	const messages: string[] = [];
	const databasePath = path.resolve('compile_commands.json');
	const entries = parseCompilationDatabase(
		JSON.stringify([
			null,
			{ directory: '.', file: 'missing-command.cpp' },
			{ directory: '.', file: 'bad-arguments.cpp', arguments: ['g++', 42] },
			{ directory: '.', file: 'bad-command.cpp', command: `g++ "unfinished` },
			{ directory: '.', file: 'unsupported.cpp', arguments: ['unknown-compiler', '-c', 'unsupported.cpp'] },
		]),
		databasePath,
		'linux',
		(message) => messages.push(message),
	);

	assert.deepEqual(entries, []);
	assert.equal(messages.length, 5);
	assert.ok(messages.every((message, index) => message.startsWith(`entry ${index}:`)));

	// A database that is not JSON at all is reported once, not once per entry.
	const jsonMessages: string[] = [];
	assert.deepEqual(
		parseCompilationDatabase('{', databasePath, 'linux', (message) => jsonMessages.push(message)),
		[],
	);
	assert.equal(jsonMessages.length, 1);
});
