import assert from 'node:assert/strict';
import test from 'node:test';
import {
	parseArtifactOptions,
	parseArtifactPresets,
	parseDefaultCompilationSettings,
	parseManualCompilationVariants,
	parseToolchainSettings,
} from '../src/services/configuration-normalization.js';

test('parses language-neutral toolchain settings', () => {
	for (const setting of [
		{
			displayName: 'Clang',
			kind: 'clang',
			executable: process.execPath,
			defaultArguments: ['-O2', '-I/project/include'],
			environment: { SDKROOT: '/sdk' },
		},
		{
			displayName: 'Rust',
			kind: 'rust',
			executable: process.execPath,
			defaultArguments: ['--edition=2021', '-C', 'opt-level=2'],
			tools: { demangler: 'rustfilt' },
		},
		{
			displayName: 'Python',
			kind: 'python',
			executable: process.execPath,
			defaultArguments: ['-O'],
			environment: { PYTHONPATH: '/project/packages' },
		},
	] as const) {
		const profile = parseToolchainSettings(setting);
		assert.ok(profile);
		assert.equal(profile.kind, setting.kind);
		assert.deepEqual(profile.defaultArguments, setting.defaultArguments);
	}
});

test('rejects unknown toolchains and defaults malformed optional fields', () => {
	assert.equal(
		parseToolchainSettings({
			displayName: 'invalid',
			kind: 'not-a-toolchain',
			executable: process.execPath,
		}),
		undefined,
	);

	const profile = parseToolchainSettings({
		displayName: 42,
		kind: 'gcc',
		executable: process.execPath,
		defaultArguments: ['-O2', 42, 'kept'],
		environment: 'not-an-object',
	});
	assert.ok(profile);
	assert.equal(profile.displayName, '');
	assert.deepEqual(profile.defaultArguments, ['-O2', 'kept']);
	assert.deepEqual(profile.environment, {});
});

test('parses default and workspace compilation settings', () => {
	assert.deepEqual(
		parseDefaultCompilationSettings({
			toolchain: 'clang',
			args: ['-O2'],
			env: { SDKROOT: '/sdk' },
			workingDirectory: '/project/build',
		}),
		{
			toolchain: 'clang',
			args: ['-O2'],
			env: { SDKROOT: '/sdk' },
			workingDirectory: '/project/build',
		},
	);
	assert.deepEqual(
		parseManualCompilationVariants([
			{
				id: 'manual:debug',
				source: '/project/main.cpp',
				displayLabel: 'Debug',
				toolchainProfileId: 'user:clang',
				workingDirectory: '/project',
				arguments: ['-O0', '-g'],
				environment: { SDKROOT: '/sdk' },
				project: 'app',
			},
			{
				id: 'missing-source',
				displayLabel: 'Invalid',
			},
		]),
		[
			{
				id: 'manual:debug',
				source: '/project/main.cpp',
				displayLabel: 'Debug',
				toolchainProfileId: 'user:clang',
				workingDirectory: '/project',
				arguments: ['-O0', '-g'],
				environment: { SDKROOT: '/sdk' },
				project: 'app',
				target: undefined,
				configuration: undefined,
			},
		],
	);
});

test('parses known artifact options into immutable disjoint groups', () => {
	const result = parseArtifactOptions(
		{
			assembly: {
				intel: true,
				labels: false,
				notAnOption: true,
			},
		},
		'assembly',
	);
	assert.equal(result.production.intel, true);
	assert.equal(result.display.labels, false);
	assert.equal(Object.isFrozen(result), true);
	assert.equal(Object.isFrozen(result.production), true);
	assert.equal(Object.isFrozen(result.display), true);
});

test('parses named artifact presets with kind-specific production inputs', () => {
	assert.deepEqual(
		parseArtifactPresets({
			optimized: {
				artifactKind: 'assembly',
				extraArguments: ['-O3'],
				productionOptions: { intel: true, labels: false },
			},
			bytes: {
				artifactKind: 'binary-disassembly',
				extraArguments: ['-Os'],
			},
			unknown: {
				artifactKind: 'not-an-artifact',
			},
		}),
		[
			{
				id: 'optimized',
				artifactKind: 'assembly',
				extraArguments: ['-O3'],
				productionOptions: { intel: true },
			},
			{
				id: 'bytes',
				artifactKind: 'binary-disassembly',
				extraArguments: ['-Os'],
				productionOptions: {},
			},
		],
	);
});
