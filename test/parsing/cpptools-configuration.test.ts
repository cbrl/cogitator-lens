import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
	compilerCommand,
	configurationArguments,
	defaultConfiguration,
	orderedConfigurations,
	parseCppToolsProperties,
	sourceLanguage,
	standardArguments,
	withoutJsonComments,
	type CppToolsContext,
} from '../../src/buildsystems/cpptools-configuration.js';

const folder = path.resolve('/workspace/project');
const context = (defaults: CppToolsContext['defaults'] = {}): CppToolsContext => ({
	workspaceFolder: folder,
	environment: { SDK: '/opt/sdk' },
	defaults,
	userHome: '/home/user',
});

test('the properties file can hold comments and trailing commas', () => {
	assert.equal(
		withoutJsonComments('{\n  // a comment\n  "a": "x // not a comment",\n  /* block */ "b": [1, 2,],\n}'),
		'{\n  \n  "a": "x // not a comment",\n   "b": [1, 2]\n}',
	);
	// A comma before a comment and the end is a trailing comma, and a comma in a string stays.
	assert.equal(withoutJsonComments('["a,]", // last\n]'), '["a,]" \n]');
	assert.equal(withoutJsonComments('{"a": "quote \\" // still text"}'), '{"a": "quote \\" // still text"}');
});

test('a configuration expands its variables and takes the defaults that it leaves out', () => {
	const [linux, windows] = parseCppToolsProperties(
		`{
			"env": { "common": ["\${workspaceFolder}/include", "\${env:SDK}/include"], "root": "/opt/root" },
			"configurations": [
				{
					"name": "Linux",
					"compilerPath": "/usr/bin/gcc-14",
					"includePath": ["\${common}", "\${workspaceFolder}/**", "\${default}"],
					"defines": ["DEBUG", "LEVEL=2"],
					"cppStandard": "gnu++20",
					"compileCommands": "\${workspaceFolder}/build/compile_commands.json",
				},
				{
					"name": "Win32",
					"compilerPath": "\${root}/cl.exe",
					"cStandard": "\${default}",
				},
				"not a configuration",
			],
			"version": 4,
		}`,
		context({ includePath: ['/usr/local/include'], cStandard: 'c17', defines: ['FROM_DEFAULTS'] }),
	);
	assert.equal(linux.name, 'Linux');
	assert.equal(linux.compilerPath, '/usr/bin/gcc-14');
	assert.deepEqual(linux.includePath, [
		`${folder}/include`,
		'/opt/sdk/include',
		`${folder}/**`,
		'/usr/local/include',
	]);
	assert.deepEqual(linux.defines, ['DEBUG', 'LEVEL=2']);
	assert.equal(linux.cppStandard, 'gnu++20');
	// cStandard is absent, so the default applies.
	assert.equal(linux.cStandard, 'c17');
	assert.deepEqual(linux.compileCommands, [path.resolve(folder, 'build/compile_commands.json')]);

	assert.equal(windows.compilerPath, '/opt/root/cl.exe');
	assert.equal(windows.cStandard, 'c17');
	assert.deepEqual(windows.includePath, ['/usr/local/include']);
	assert.deepEqual(windows.defines, ['FROM_DEFAULTS']);
	assert.deepEqual(windows.compileCommands, []);
});

test('a file that is not valid gives no configurations', () => {
	assert.deepEqual(parseCppToolsProperties('{ "configurations": [', context()), []);
	assert.deepEqual(parseCppToolsProperties('{ "configurations": {} }', context()), []);
});

test('the default settings alone give a configuration when they name a compiler or a database', () => {
	assert.equal(defaultConfiguration(context({ includePath: ['/x'] })), undefined);
	const configuration = defaultConfiguration(context({ compilerPath: '/usr/bin/clang', cppStandard: 'c++17' }));
	assert.equal(configuration?.compilerPath, '/usr/bin/clang');
	assert.equal(configuration?.cppStandard, 'c++17');
	assert.deepEqual(defaultConfiguration(context({ compileCommands: ['build/a.json'] }))?.compileCommands, [
		path.resolve(folder, 'build/a.json'),
	]);
});

test('compilerPath is a file or a command line', () => {
	const files = new Set(['/opt/My Compilers/gcc']);
	const isFile = (candidate: string) => files.has(candidate);
	assert.deepEqual(compilerCommand('/opt/My Compilers/gcc', isFile, 'linux'), {
		executable: '/opt/My Compilers/gcc',
		args: [],
	});
	assert.deepEqual(compilerCommand('"/opt/other gcc/gcc" -m32 -O1', isFile, 'linux'), {
		executable: '/opt/other gcc/gcc',
		args: ['-m32', '-O1'],
	});
	assert.deepEqual(compilerCommand('"C:/MinGW/bin/gcc.exe" -m32', isFile, 'win32'), {
		executable: 'C:/MinGW/bin/gcc.exe',
		args: ['-m32'],
	});
	assert.equal(compilerCommand('  ', isFile, 'linux'), undefined);
});

test('the arguments follow the dialect and the language of the source', () => {
	const [configuration] = parseCppToolsProperties(
		JSON.stringify({
			configurations: [
				{
					name: 'Mixed',
					includePath: ['/inc', '/inc', '/deep/**', '/one/*'],
					defines: ['A', 'B=1'],
					forcedInclude: ['/pch.h'],
					macFrameworkPath: ['/Frameworks'],
					cStandard: 'c11',
					cppStandard: 'c++23',
					compilerArgs: ['-Wall'],
				},
			],
		}),
		context(),
	);
	assert.deepEqual(configurationArguments(configuration, 'gnu', 'cpp', ['-m32'], 'linux'), [
		'-m32',
		'-std=c++23',
		'-DA',
		'-DB=1',
		'-I/inc',
		'-I/deep',
		'-I/one',
		'-include',
		'/pch.h',
		'-Wall',
	]);
	assert.deepEqual(configurationArguments(configuration, 'gnu', 'c', [], 'darwin').slice(0, 1), ['-std=c11']);
	assert.ok(configurationArguments(configuration, 'gnu', 'c', [], 'darwin').includes('-F/Frameworks'));
	assert.deepEqual(configurationArguments(configuration, 'msvc', 'cpp', [], 'win32'), [
		'/std:c++latest',
		'/DA',
		'/DB=1',
		'/I/inc',
		'/I/deep',
		'/I/one',
		'/FI/pch.h',
		'-Wall',
	]);
});

test('cl.exe gets only the standards that it knows', () => {
	assert.deepEqual(standardArguments('gnu++20', 'msvc', 'cpp'), ['/std:c++20']);
	assert.deepEqual(standardArguments('c++14', 'msvc', 'cpp'), ['/std:c++14']);
	assert.deepEqual(standardArguments('c++11', 'msvc', 'cpp'), []);
	assert.deepEqual(standardArguments('c17', 'msvc', 'c'), ['/std:c17']);
	assert.deepEqual(standardArguments('gnu18', 'msvc', 'c'), ['/std:c17']);
	assert.deepEqual(standardArguments('c23', 'msvc', 'c'), ['/std:clatest']);
	assert.deepEqual(standardArguments('c99', 'msvc', 'c'), []);
	assert.deepEqual(standardArguments('gnu99', 'gnu', 'c'), ['-std=gnu99']);
	assert.deepEqual(standardArguments('${default}', 'gnu', 'c'), []);
});

test('C and Objective-C sources take the C standard', () => {
	assert.equal(sourceLanguage('/src/main.c'), 'c');
	assert.equal(sourceLanguage('/src/view.m'), 'c');
	assert.equal(sourceLanguage('/src/main.cpp'), 'cpp');
	assert.equal(sourceLanguage('/src/kernel.cu'), 'cpp');
	assert.equal(sourceLanguage('/src/view.mm'), 'cpp');
});

test('the language of the open document selects the standard before the extension', () => {
	assert.equal(sourceLanguage('/src/util.h', 'c'), 'c');
	assert.equal(sourceLanguage('/src/util.h', 'cpp'), 'cpp');
	assert.equal(sourceLanguage('/src/util.h'), 'cpp');
	assert.equal(sourceLanguage('/src/main.c', 'cpp'), 'cpp');
	assert.equal(sourceLanguage('/src/view.m', 'objective-c'), 'c');
	assert.equal(sourceLanguage('/src/kernel.cu', 'cuda'), 'cpp');
	assert.equal(sourceLanguage('/src/main.c', 'plaintext'), 'c');
});

test('the configuration of the platform comes first, and each key stays when the configurations move', () => {
	const configurations = parseCppToolsProperties(
		JSON.stringify({
			configurations: [
				{ name: 'Mac', compilerPath: '/usr/bin/clang' },
				{ name: 'Linux', compilerPath: '/usr/bin/gcc' },
				{ name: 'Win32', compilerPath: 'cl.exe' },
				{ name: 'Linux', compilerPath: '/usr/bin/clang' },
			],
		}),
		context(),
	);
	const keys = (platform: NodeJS.Platform, entries = configurations) =>
		orderedConfigurations(entries, platform).map((entry) => entry.key);
	assert.deepEqual(keys('win32'), ['Win32', 'Mac', 'Linux', 'Linux#2']);
	assert.deepEqual(keys('linux'), ['Linux', 'Linux#2', 'Mac', 'Win32']);
	assert.deepEqual(keys('darwin'), ['Mac', 'Linux', 'Win32', 'Linux#2']);
	assert.deepEqual(keys('freebsd'), ['Mac', 'Linux', 'Win32', 'Linux#2']);
	assert.deepEqual(
		orderedConfigurations(configurations, 'linux').map((entry) => entry.configuration.compilerPath),
		['/usr/bin/gcc', '/usr/bin/clang', '/usr/bin/clang', 'cl.exe'],
	);
	// A new configuration above the others does not change their keys.
	const added = parseCppToolsProperties(
		JSON.stringify({ configurations: [{ name: 'Embedded', compilerPath: '/opt/arm/bin/gcc' }] }),
		context(),
	);
	assert.deepEqual(keys('win32', [...added, ...configurations]), ['Win32', 'Embedded', 'Mac', 'Linux', 'Linux#2']);
});
