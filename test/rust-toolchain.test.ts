import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { intelOutputArguments } from '../src/toolchains/toolchain-backend.js';
import { rustOutputArguments, stripRustManagedArguments } from '../src/toolchains/rust.js';
import { toolchainDefinitions } from '../src/toolchains/toolchain-map.js';

test('Rust assembly sanitization removes conflicting output and diagnostic arguments', () => {
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

test('Rust output arguments supply defaults while preserving project crate identity', () => {
	assert.deepEqual(rustOutputArguments('assembly', 'output.s', ['--edition=2021']), [
		'--crate-name=coglens_artifact',
		'--crate-type=lib',
		'--emit=asm',
		'-C',
		'debuginfo=1',
		'--error-format=human',
		'--color=never',
		'-o',
		'output.s',
	]);

	const output = rustOutputArguments('object', 'output.o', []);
	assert.ok(output.includes('--emit=obj'));
	assert.equal(output.includes('--emit=asm'), false);

	const projectOutput = rustOutputArguments('assembly', 'output.s', [
		'--crate-name',
		'application',
		'--crate-type=bin',
	]);
	assert.equal(projectOutput.includes('--crate-name=coglens_artifact'), false);
	assert.equal(projectOutput.includes('--crate-type=lib'), false);
});

test('Rust Intel syntax uses the rustc LLVM codegen option only when selected', () => {
	assert.deepEqual(intelOutputArguments(toolchainDefinitions.rust, { intel: true, demangle: false }), [
		'-C',
		'llvm-args=-x86-asm-syntax=intel',
	]);
	assert.deepEqual(intelOutputArguments(toolchainDefinitions.rust, { intel: false, demangle: false }), []);
});
