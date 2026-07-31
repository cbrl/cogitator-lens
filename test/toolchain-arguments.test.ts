import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { removeSourceArgument } from '../src/toolchain-arguments.js';
import { stripCompilerManagedArguments } from '../src/toolchains/toolchain-backend.js';

test('removes source, output, dependency, and mode arguments owned by the extension', () => {
	assert.deepEqual(
		stripCompilerManagedArguments([
			'-O2',
			'-c',
			'-o',
			'old.o',
			'-MFdeps.d',
			'/Faold.asm',
			'-emit-llvm',
			'-fsave-optimization-record=yaml',
			'-foptimization-record-file=old.opt.yaml',
			'-fopt-info-all=old.opt',
			'/clang:-emit-llvm',
			'/clang:-S',
			'/clang:-gline-tables-only',
			'/clang:-o',
			'/clang:old.ll',
			'/clang:-fsave-optimization-record=yaml',
			'/clang:-foptimization-record-file=old.opt.yaml',
			'/tmp/source.cpp',
			'-Wall',
		], '/tmp/source.cpp'),
		['-O2', '-Wall'],
	);
});

test('removes a relative source argument using the compilation working directory', () => {
	const workingDirectory = path.resolve('project', 'build');
	const source = path.resolve(workingDirectory, '..', 'src', 'main.cpp');
	assert.deepEqual(
		removeSourceArgument(
			['-O2', path.join('..', 'src', 'main.cpp'), '-Wall'],
			source,
			workingDirectory,
		),
		['-O2', '-Wall'],
	);
});
