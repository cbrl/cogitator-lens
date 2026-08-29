import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
	artifactDefinitions,
	supportedArtifactKinds,
} from '../src/artifacts/core/artifact-definitions.js';
import {
	effectiveArtifactPresets,
	resolveArtifactPreset,
} from '../src/artifacts/ui/presets.js';
import {
	supportedToolchainKinds,
	toolchainDefinitions,
} from '../src/toolchains/toolchain-map.js';
import { ToolchainBackend } from '../src/toolchains/toolchain-backend.js';
import {
	artifactOptionsEqual,
	defaultArtifactOptions,
	immutableArtifactOptions,
	productionKey,
	type ArtifactRenderContext,
	type ArtifactRequest,
	type RawArtifact,
} from '../src/types/index.js';

test('artifact and toolchain tables define the complete cross-product', () => {
	assert.ok(supportedArtifactKinds.length > 0);
	for (const toolchainKind of supportedToolchainKinds) {
		const definition = toolchainDefinitions[toolchainKind];
		assert.deepEqual(Object.keys(definition.artifacts), supportedArtifactKinds);
		assert.ok(definition.languageIdentifiers.length > 0);
		assert.ok(Object.values(definition.artifacts).some(cell => cell.status === 'available'));
	}
});

test('the manifest toolchain-kind enum and artifactOptions schema stay synchronized with the code tables', () => {
	const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8')) as {
		version: string;
		capabilities: {
			untrustedWorkspaces: { supported: boolean };
		};
		contributes: {
			commands: Array<{ command: string }>;
			views: { coglens: Array<{ id: string }> };
			colors: Array<{ id: string }>;
			configuration: Array<{
				properties: {
					'coglens.toolchains': {
						items: { properties: { kind: { enum: string[] } } };
					};
					'coglens.artifactOptions': {
						properties: Readonly<Record<string, { properties: Readonly<Record<string, unknown>> }>>;
					};
					'coglens.artifactPresets': {
						additionalProperties: {
							properties: {
								artifactKind: { enum: string[] };
								productionOptions: { properties: Readonly<Record<string, unknown>> };
							};
						};
					};
				};
			}>;
			menus: unknown;
		};
	};
	const configuration = manifest.contributes.configuration[0].properties;
	assert.deepEqual(
		[...configuration['coglens.toolchains'].items.properties.kind.enum].sort(),
		[...supportedToolchainKinds].sort(),
	);
	for (const kind of supportedArtifactKinds) {
		assert.deepEqual(
			Object.keys(configuration['coglens.artifactOptions'].properties[kind].properties).sort(),
			artifactDefinitions[kind].options.map(option => option.id).sort(),
		);
	}
	assert.deepEqual(
		configuration['coglens.artifactPresets']
			.additionalProperties.properties.artifactKind.enum,
		supportedArtifactKinds,
	);
	assert.deepEqual(
		Object.keys(configuration['coglens.artifactPresets']
			.additionalProperties.properties.productionOptions.properties).sort(),
		Object.keys(defaultArtifactOptions.production).sort(),
	);
	assert.equal(manifest.capabilities.untrustedWorkspaces.supported, false);
	assert.doesNotMatch(JSON.stringify(manifest.contributes.menus), /editorLangId/);
	assert.equal(manifest.version, '0.7.0');
	assert.ok(manifest.contributes.commands.some(command =>
		command.command === 'coglens.OpenControlFlowGraph'));
	assert.ok(manifest.contributes.views.coglens.some(view =>
		view.id === 'coglens.artifactDetails'));
	assert.ok(manifest.contributes.colors.some(color =>
		color.id === 'coglens.stackUsage.background'));
	assert.match(fs.readFileSync('.vscodeignore', 'utf8'), /^test\/\*\*$/m);
	assert.match(fs.readFileSync('.vscodeignore', 'utf8'), /^plans\/\*\*$/m);
});

test('the default preset is total and a configured default overrides it', () => {
	assert.deepEqual(resolveArtifactPreset('default'), {
		id: 'default',
		artifactKind: 'assembly',
		extraArguments: [],
		productionOptions: {},
	});
	const configured = {
		id: 'default',
		artifactKind: 'assembly',
		extraArguments: ['--custom'],
		productionOptions: { intel: true },
	} as const;
	const presets = effectiveArtifactPresets([configured]);
	assert.deepEqual(presets.get('default'), configured);
	assert.equal(effectiveArtifactPresets([{
		...configured,
		artifactKind: 'binary-disassembly',
	}], 'assembly').get('default')?.artifactKind, 'assembly');
	assert.equal(resolveArtifactPreset('missing'), undefined);
});

test('production keys exclude display options and include every production request input', () => {
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
	const initial = productionKey(request, source);
	assert.equal(productionKey({
		...request,
		onInvocation: () => {},
	}, source), initial);
	assert.equal(productionKey({
		...request,
		options: {
			...defaultArtifactOptions,
			display: { ...defaultArtifactOptions.display, labels: false },
		},
	}, source), initial);
	assert.notEqual(productionKey({
		...request,
		options: {
			...defaultArtifactOptions,
			production: { ...defaultArtifactOptions.production, intel: true },
		},
	}, source), initial);
	assert.notEqual(productionKey({
		...request,
		extraArguments: ['--preset'],
	}, source), initial);
	assert.notEqual(productionKey({
		...request,
		presetId: 'optimized',
	}, source), initial);
	assert.notEqual(productionKey({
		...request,
		artifactOutputId: 'assembly',
	}, source), initial);

	const optionsCopy = immutableArtifactOptions(defaultArtifactOptions);
	assert.equal(artifactOptionsEqual(defaultArtifactOptions, optionsCopy), true);
	assert.equal(artifactOptionsEqual(defaultArtifactOptions, {
		...optionsCopy,
		display: { ...optionsCopy.display, labels: false },
	}), false);
});

test('assembly rendering maps parsed lines without a binary-mode disassembly fallback', () => {
	const backend = new ToolchainBackend(
		{
			id: 'test:gcc',
			displayName: 'Test GCC',
			kind: 'gcc',
			executable: process.execPath,
			defaultArguments: [],
			environment: {},
			tools: {},
		},
		toolchainDefinitions.gcc,
	);
	const raw: RawArtifact = {
		kind: 'assembly',
		text: 'main:\n  ret\n',
		diagnostics: [],
		durationMs: 1,
		generatedAt: 0,
		command: {
			executable: process.execPath,
			arguments: [],
			environmentVariableNames: [],
			workingDirectory: process.cwd(),
		},
		truncated: false,
		inputs: [],
		dependencyCoverage: 'source-only',
	};
	const rendered = artifactDefinitions.assembly.renderer(
		raw,
		defaultArtifactOptions.display,
		renderContext(backend),
	);
	assert.ok(rendered.lines.some(line => line.text.includes('ret')));
	assert.ok(rendered.lines.every(line => line.opcodes === undefined));
	assert.ok(rendered.lines.every(line => line.disassembly === undefined));
});

function renderContext(backend: ToolchainBackend): ArtifactRenderContext {
	return {
		backend,
		source: {
			uri: { fsPath: '/project/source.cpp' } as never,
			text: '',
		},
	};
}
