import assert from 'node:assert/strict';
import test from 'node:test';
import { effectiveArtifactPresets, resolveArtifactPreset } from '../src/artifacts/ui/presets.js';
import {
	parseArtifactOptions,
	parseArtifactPresets,
	parseDefaultCompilationSettings,
	parseManualCompilationVariants,
	parseToolchainSettings,
} from '../src/services/configuration-normalization.js';
import {
	artifactOptionsEqual,
	defaultArtifactOptions,
	immutableArtifactOptions,
	productionKey,
	type ArtifactRequest,
} from '../src/types/index.js';

test('toolchain settings are accepted for every supported kind and rejected for unknown ones', () => {
	for (const setting of [
		{ displayName: 'Clang', kind: 'clang', executable: process.execPath, defaultArguments: ['-O2', '-I/include'] },
		{ displayName: 'Rust', kind: 'rust', executable: process.execPath, defaultArguments: ['--edition=2021'] },
		{ displayName: 'Python', kind: 'python', executable: process.execPath, defaultArguments: ['-O'] },
	] as const) {
		const profile = parseToolchainSettings(setting);
		assert.ok(profile);
		assert.equal(profile.kind, setting.kind);
		assert.deepEqual(profile.defaultArguments, setting.defaultArguments);
	}
	assert.equal(
		parseToolchainSettings({ displayName: 'invalid', kind: 'not-a-toolchain', executable: process.execPath }),
		undefined,
	);
});

test('malformed optional toolchain fields fall back to empty values instead of failing', () => {
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

test('compilation settings and manual variants keep documented fields and drop incomplete entries', () => {
	assert.deepEqual(
		parseDefaultCompilationSettings({
			toolchain: 'clang',
			args: ['-O2'],
			env: { SDKROOT: '/sdk' },
			workingDirectory: '/project/build',
		}),
		{ toolchain: 'clang', args: ['-O2'], env: { SDKROOT: '/sdk' }, workingDirectory: '/project/build' },
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
			{ id: 'missing-source', displayLabel: 'Invalid' },
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

test('artifact options are split into frozen production and display groups', () => {
	const result = parseArtifactOptions({ assembly: { intel: true, labels: false, notAnOption: true } }, 'assembly');
	assert.equal(result.production.intel, true);
	assert.equal(result.display.labels, false);
	assert.ok(Object.isFrozen(result) && Object.isFrozen(result.production) && Object.isFrozen(result.display));
});

test('presets keep kind-specific production inputs and drop unknown artifact kinds', () => {
	assert.deepEqual(
		parseArtifactPresets({
			optimized: {
				artifactKind: 'assembly',
				extraArguments: ['-O3'],
				productionOptions: { intel: true, labels: false },
			},
			bytes: { artifactKind: 'binary-disassembly', extraArguments: ['-Os'] },
			unknown: { artifactKind: 'not-an-artifact' },
		}),
		[
			{ id: 'optimized', artifactKind: 'assembly', extraArguments: ['-O3'], productionOptions: { intel: true } },
			{ id: 'bytes', artifactKind: 'binary-disassembly', extraArguments: ['-Os'], productionOptions: {} },
		],
	);
});

test('the built-in default preset is total and a configured default replaces it', () => {
	assert.deepEqual(resolveArtifactPreset('default'), {
		id: 'default',
		artifactKind: 'assembly',
		extraArguments: [],
		productionOptions: {},
	});
	assert.equal(resolveArtifactPreset('missing'), undefined);

	const configured = {
		id: 'default',
		artifactKind: 'assembly',
		extraArguments: ['--custom'],
		productionOptions: { intel: true },
	} as const;
	assert.deepEqual(effectiveArtifactPresets([configured]).get('default'), configured);
	// A default preset that names another artifact cannot override the requested one.
	assert.equal(
		effectiveArtifactPresets([{ ...configured, artifactKind: 'binary-disassembly' }], 'assembly').get('default')
			?.artifactKind,
		'assembly',
	);
});

test('the production cache key covers every production input and ignores display options', () => {
	const request: ArtifactRequest = {
		variant: {
			id: 'variant',
			provider: 'test',
			source: { toJSON: () => 'source' } as never,
			toolchainProfileId: 'test:tool',
			workingDirectory: '/work',
			arguments: ['--variant'],
			environment: {},
			displayLabel: 'Variant',
		},
		artifactKind: 'assembly',
		presetId: 'default',
		extraArguments: [],
		options: defaultArtifactOptions,
		cancellationToken: {} as never,
	};
	const source = { size: 10, mtimeMs: 20 };
	const baseline = productionKey(request, source);

	for (const equivalent of [
		{ ...request, onInvocation: () => {} },
		{
			...request,
			options: { ...defaultArtifactOptions, display: { ...defaultArtifactOptions.display, labels: false } },
		},
	]) {
		assert.equal(productionKey(equivalent, source), baseline);
	}
	for (const different of [
		{
			...request,
			options: {
				...defaultArtifactOptions,
				production: { ...defaultArtifactOptions.production, intel: true },
			},
		},
		{ ...request, extraArguments: ['--preset'] },
		{ ...request, presetId: 'optimized' },
		{ ...request, artifactOutputId: 'assembly' },
	]) {
		assert.notEqual(productionKey(different, source), baseline);
	}
});

test('artifact option equality distinguishes display changes from an unchanged copy', () => {
	const copy = immutableArtifactOptions(defaultArtifactOptions);
	assert.equal(artifactOptionsEqual(defaultArtifactOptions, copy), true);
	assert.equal(
		artifactOptionsEqual(defaultArtifactOptions, { ...copy, display: { ...copy.display, labels: false } }),
		false,
	);
});
