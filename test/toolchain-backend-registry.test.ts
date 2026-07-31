import assert from 'node:assert/strict';
import test from 'node:test';
import {
	detectToolchainDefinition,
	getToolchainDefinition,
	resolveArtifactOptionAvailability,
} from '../src/toolchains/toolchain-map.js';
import type { ToolchainKind, ToolchainProfile } from '../src/types/index.js';

// Manifest-sync coverage for coglens.toolchains and coglens.artifactOptions
// lives in test/artifact-foundation.test.ts, alongside the artifact-kind table.

test('registry definitions own generic flags and option availability', () => {
	const gcc = profile('gcc');
	assert.equal(getToolchainDefinition('gcc').includeFlag, '-I');
	assert.equal(getToolchainDefinition('gcc').defineFlag, '-D');
	assert.equal(gcc.tools.demangler, undefined);
	assert.equal(
		resolveArtifactOptionAvailability(gcc, 'assembly', 'demangle').status,
		'unavailable',
	);

	const msvc = profile('msvc');
	assert.equal(getToolchainDefinition('msvc').includeFlag, '/I');
	assert.equal(getToolchainDefinition('msvc').defineFlag, '/D');
	const msvcIntel = resolveArtifactOptionAvailability(msvc, 'assembly', 'intel');
	assert.equal(msvcIntel.status, 'unavailable');
	assert.equal(msvcIntel.reason, 'inherent');

	const configured = {
		...profile('clang'),
		tools: { demangler: process.execPath },
	};
	assert.equal(
		resolveArtifactOptionAvailability(configured, 'assembly', 'demangle').status,
		'available',
	);
	assert.equal(
		resolveArtifactOptionAvailability(configured, 'assembly', 'intel').status,
		'available',
	);

	const rust = profile('rust');
	assert.equal(getToolchainDefinition('rust').includeFlag, undefined);
	assert.equal(getToolchainDefinition('rust').defineFlag, '--cfg=');

	const python = profile('python');
	assert.equal(getToolchainDefinition('python').includeFlag, undefined);
	assert.equal(getToolchainDefinition('python').defineFlag, undefined);
	assert.equal(getToolchainDefinition('python').outputArguments, undefined);
	assert.equal(getToolchainDefinition('python').createParser, undefined);
	assert.equal(
		resolveArtifactOptionAvailability(python, 'assembly', 'intel').status,
		'unsupported',
	);
});

test('registry definitions own dependency argument and parser actions', () => {
	const gcc = getToolchainDefinition('gcc').dependencyCollection;
	assert.ok(gcc);
	assert.equal(gcc.outputFilename, 'dependencies.d');
	assert.deepEqual(gcc.arguments('deps.d', '/temporary', ['-O2']), [
		'-M',
		'-MF',
		'deps.d',
	]);

	const msvc = getToolchainDefinition('msvc').dependencyCollection;
	assert.ok(msvc);
	assert.equal(msvc.outputFilename, 'dependencies.json');
	assert.deepEqual(msvc.arguments('deps.json', '/temporary', ['/O2']).slice(0, 3), [
		'/c',
		'/sourceDependencies',
		'deps.json',
	]);

	const rust = getToolchainDefinition('rust').dependencyCollection;
	assert.ok(rust);
	assert.deepEqual(
		rust.arguments('deps.d', '/temporary', ['--crate-name=real']),
		[
			'--crate-type=lib',
			'--emit=dep-info=deps.d',
			'--error-format=human',
			'--color=never',
		],
	);
	assert.equal(getToolchainDefinition('python').dependencyCollection, undefined);
});

test('registry detection returns the matching definition and disambiguates Apple Clang', () => {
	assert.equal(detectToolchainDefinition('g++-14', '', 'linux')?.kind, 'gcc');
	assert.equal(detectToolchainDefinition('clang++-19', '', 'linux')?.kind, 'clang');
	assert.equal(detectToolchainDefinition('cl.exe', '', 'win32')?.kind, 'msvc');
	assert.equal(detectToolchainDefinition('rustc', '', 'linux')?.kind, 'rust');
	assert.equal(detectToolchainDefinition('python3.13', '', 'linux')?.kind, 'python');
	assert.equal(detectToolchainDefinition('clang-cl.exe', '', 'win32')?.kind, 'clang-cl');
	assert.equal(
		detectToolchainDefinition('clang', 'Apple clang version 17', 'linux')?.kind,
		'apple-clang',
	);
	assert.equal(detectToolchainDefinition('not-gcc', '', 'linux'), undefined);
	assert.equal(detectToolchainDefinition('compiler-wrapper', '', 'linux'), undefined);
});

function profile(kind: ToolchainKind): ToolchainProfile {
	return {
		id: `test:${kind}`,
		displayName: `Test ${kind}`,
		kind,
		executable: process.execPath,
		defaultArguments: [],
		environment: {},
		tools: {},
	};
}
