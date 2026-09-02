import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { CommandLineSyntaxError, tokenizePosix, tokenizeWindows } from '../../src/tokenize.js';
import { removeSourceArgument } from '../../src/toolchain-arguments.js';
import { stripCompilerManagedArguments } from '../../src/toolchains/c-family.js';
import { stripPythonManagedArguments } from '../../src/toolchains/python.js';
import { stripRustManagedArguments } from '../../src/toolchains/rust.js';

test('POSIX tokenization handles quoting, escaping, and unterminated quotes', () => {
	assert.deepEqual(tokenizePosix(`-DNAME='hello world' -I"/path with spaces" escaped\\ value ""`), [
		'-DNAME=hello world',
		'-I/path with spaces',
		'escaped value',
		'',
	]);
	assert.throws(() => tokenizePosix(`-DVALUE='unfinished`), CommandLineSyntaxError);
});

test('Windows tokenization handles quoting and backslash runs', () => {
	assert.deepEqual(tokenizeWindows(String.raw`/DNAME="hello world" "/Ipath with spaces" plain`), [
		'/DNAME=hello world',
		'/Ipath with spaces',
		'plain',
	]);
	assert.deepEqual(tokenizeWindows(String.raw`"a\\\"b" c`), [String.raw`a\"b`, 'c']);
});

test('native argument stripping removes every output, dependency, and mode flag the extension owns', () => {
	assert.deepEqual(
		stripCompilerManagedArguments(
			[
				'-O2',
				'-c',
				'-E',
				'-fsyntax-only',
				'-Xclang',
				'-ast-dump',
				'-o',
				'old.o',
				'-MFdeps.d',
				'/Faold.asm',
				'/E',
				'/sourceDependencies',
				'old-dependencies.json',
				'/Fiold.i',
				'-emit-llvm',
				'-fsave-optimization-record=yaml',
				'-foptimization-record-file=old.opt.yaml',
				'-fopt-info-all=old.opt',
				'-fstack-usage',
				'-fno-stack-usage',
				'-fdump-tree-cfg-details-lineno=old.cfg',
				'-save-temps=cwd',
				'-dumpdir',
				'old-dumps/',
				'-dumpdir=other-dumps/',
				'/clang:-emit-llvm',
				'/clang:-S',
				'/clang:-gline-tables-only',
				'/clang:-o',
				'/clang:old.ll',
				'/clang:-fsave-optimization-record=yaml',
				'/clang:-foptimization-record-file=old.opt.yaml',
				'/clang:-fstack-usage',
				'/clang:-fno-stack-usage',
				'/tmp/source.cpp',
				'-Wall',
			],
			'/tmp/source.cpp',
		),
		['-O2', '-Wall'],
	);
});

test('Rust argument stripping removes conflicting output and diagnostic arguments', () => {
	const workingDirectory = path.resolve('project');
	const source = path.join(workingDirectory, 'source.rs');
	assert.deepEqual(
		stripRustManagedArguments(
			[
				'--edition=2021',
				'--emit=metadata,link',
				'--out-dir',
				'old-output',
				'--error-format=json',
				'--json',
				'diagnostic-rendered-ansi',
				'--color=always',
				'-o',
				'old.rlib',
				source,
				'-C',
				'opt-level=2',
			],
			source,
			workingDirectory,
		),
		['--edition=2021', '-C', 'opt-level=2'],
	);
});

test('Python argument stripping removes only extension-owned execution modes and source paths', () => {
	const workingDirectory = process.cwd();
	const source = path.join(workingDirectory, 'main.py');
	assert.deepEqual(
		stripPythonManagedArguments(['-O', '-X', 'dev', '-m', 'module', './main.py', '--'], source, workingDirectory),
		['-O', '-X', 'dev'],
	);
	assert.deepEqual(stripPythonManagedArguments(['-cprint(1)', '-mtrace', '-B'], source, workingDirectory), ['-B']);
});

test('a relative source argument is removed using the compilation working directory', () => {
	const workingDirectory = path.resolve('project', 'build');
	const source = path.resolve(workingDirectory, '..', 'src', 'main.cpp');
	assert.deepEqual(
		removeSourceArgument(['-O2', path.join('..', 'src', 'main.cpp'), '-Wall'], source, workingDirectory),
		['-O2', '-Wall'],
	);
});
