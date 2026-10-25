import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
	parseDefaultCompilationSettings,
	parseManualCompilationVariants,
	parseToolchainSettings,
} from '../src/services/configuration-normalization.js';
import { expandVariables, portablePath, resolvePathSetting, type PathContext } from '../src/services/path-variables.js';

const app = path.resolve('/work/app');
const library = path.resolve('/work/library');
const context: PathContext = {
	folders: [
		{ name: 'app', path: app },
		{ name: 'library', path: library },
	],
	defaultFolder: app,
	userHome: path.resolve('/home/user'),
	environment: { SDK: path.resolve('/opt/sdk') },
};

test('setting variables expand like VS Code task variables', () => {
	assert.equal(expandVariables('${workspaceFolder}/src', context), `${app}/src`);
	assert.equal(expandVariables('-I${workspaceFolder:library}/include', context), `-I${library}/include`);
	assert.equal(expandVariables('${userHome}/.local', context), `${path.resolve('/home/user')}/.local`);
	assert.equal(expandVariables('${env:SDK}/bin/cc', context), `${path.resolve('/opt/sdk')}/bin/cc`);
	assert.equal(expandVariables('${env:MISSING}', context), '');
	assert.equal(
		expandVariables('${workspaceFolder:unknown}/x', context),
		'${workspaceFolder:unknown}/x',
		'A folder that is not open stays visible in the path',
	);
});

test('path settings resolve relative values against the default folder', () => {
	assert.equal(resolvePathSetting('src/main.cpp', context), path.join(app, 'src', 'main.cpp'));
	assert.equal(resolvePathSetting('${workspaceFolder:library}/a.c', context), path.join(library, 'a.c'));
	assert.equal(resolvePathSetting('', context), '');
});

test('paths written from the sidebar are relative to a workspace folder when they are inside one', () => {
	assert.equal(portablePath(path.join(app, 'src', 'main.cpp'), context), '${workspaceFolder}/src/main.cpp');
	assert.equal(portablePath(app, context), '${workspaceFolder}');
	assert.equal(portablePath(path.join(library, 'a.c'), context), '${workspaceFolder:library}/a.c');
	assert.equal(portablePath(path.join(app, '..cache', 'x'), context), '${workspaceFolder}/..cache/x');
	const outside = path.resolve('/usr/bin/gcc');
	assert.equal(portablePath(outside, context), outside);
	assert.equal(portablePath('build', context), 'build');
});

test('settings parsers expand variables in paths, arguments, and environments', () => {
	const [variant] = parseManualCompilationVariants(
		[
			{
				id: 'manual:a',
				source: '${workspaceFolder}/src/main.cpp',
				displayLabel: 'A',
				toolchainProfileId: 'user:gcc',
				workingDirectory: 'build',
				arguments: ['-I${workspaceFolder:library}/include'],
				environment: { PATH: '${env:SDK}/bin' },
			},
		],
		context,
	);
	assert.equal(variant.source, path.join(app, 'src', 'main.cpp'));
	assert.equal(variant.workingDirectory, path.join(app, 'build'));
	assert.deepEqual(variant.arguments, [`-I${library}/include`]);
	assert.deepEqual(variant.environment, { PATH: `${path.resolve('/opt/sdk')}/bin` });

	const toolchain = parseToolchainSettings(
		{
			displayName: 'SDK',
			kind: 'gcc',
			executable: '${env:SDK}/bin/gcc',
			defaultArguments: ['-I${workspaceFolder}'],
		},
		context,
	);
	assert.equal(toolchain?.executable, path.normalize(`${path.resolve('/opt/sdk')}/bin/gcc`));
	assert.deepEqual(toolchain?.defaultArguments, [`-I${app}`]);
	assert.equal(
		parseToolchainSettings({ displayName: 'gcc', kind: 'gcc', executable: 'gcc' }, context)?.executable,
		'gcc',
		'A bare executable name is still looked up on PATH',
	);

	assert.equal(
		parseDefaultCompilationSettings({ toolchain: 'gcc', workingDirectory: 'out' }, context).workingDirectory,
		path.join(app, 'out'),
	);
});
