import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { artifactDefinitions, supportedArtifactKinds } from '../src/artifacts/core/artifact-definitions.js';
import { supportedToolchainKinds } from '../src/toolchains/toolchain-map.js';
import { defaultArtifactOptions } from '../src/types/index.js';
import { repositoryRoot } from './support/environment.js';
import { generateManifest, validateOptionDescriptors } from '../scripts/generate-manifest.js';

interface Manifest {
	readonly capabilities: { readonly untrustedWorkspaces: { readonly supported: boolean } };
	readonly contributes: {
		readonly keybindings: readonly { readonly command: string; readonly when: string }[];
		readonly configuration: readonly {
			readonly properties: {
				readonly 'coglens.toolchains': { items: { properties: { kind: { enum: string[] } } } };
				readonly 'coglens.artifactOptions': Readonly<
					Record<'properties', Readonly<Record<string, { properties: Readonly<Record<string, unknown>> }>>>
				>;
				readonly 'coglens.artifactPresets': {
					additionalProperties: {
						properties: {
							artifactKind: { enum: string[] };
							productionOptions: { properties: Readonly<Record<string, unknown>> };
						};
					};
				};
			};
		}[];
		readonly menus: unknown;
	};
}

const manifest = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8')) as Manifest;
const configuration = manifest.contributes.configuration[0].properties;

test('the manifest settings schema stays synchronized with the code tables', () => {
	assert.deepEqual(generateManifest(manifest as unknown as Record<string, unknown>), manifest);
	assert.deepEqual(
		[...configuration['coglens.toolchains'].items.properties.kind.enum].sort(),
		[...supportedToolchainKinds].sort(),
	);
	for (const kind of supportedArtifactKinds) {
		assert.deepEqual(
			Object.keys(configuration['coglens.artifactOptions'].properties[kind].properties).sort(),
			artifactDefinitions[kind].options.map((option) => option.id).sort(),
			`option schema drift for ${kind}`,
		);
	}
	assert.deepEqual(
		configuration['coglens.artifactPresets'].additionalProperties.properties.artifactKind.enum,
		supportedArtifactKinds,
	);
	assert.deepEqual(
		Object.keys(
			configuration['coglens.artifactPresets'].additionalProperties.properties.productionOptions.properties,
		).sort(),
		Object.keys(defaultArtifactOptions.production).sort(),
	);
});

test('manifest generation rejects conflicting duplicate option descriptors', () => {
	assert.throws(
		() =>
			validateOptionDescriptors([
				{ options: [{ id: 'intel', group: 'production', label: 'Intel syntax', description: 'first' }] },
				{ options: [{ id: 'intel', group: 'production', label: 'Intel syntax', description: 'second' }] },
			]),
		/Conflicting artifact option descriptor: intel/u,
	);
});

test('the manifest keeps its trust, menu, keybinding, and packaging commitments', () => {
	assert.equal(manifest.capabilities.untrustedWorkspaces.supported, false);
	// Menus gate on the extension's own context key, never on a language id.
	assert.doesNotMatch(JSON.stringify(manifest.contributes.menus), /editorLangId/);
	assert.deepEqual(
		manifest.contributes.keybindings.map((binding) => binding.command),
		['coglens.OpenArtifact', 'coglens.OpenControlFlowGraph', 'coglens.CompareArtifacts'],
	);
	assert.ok(manifest.contributes.keybindings.every((binding) => binding.when.includes('coglens.supportedSource')));
	assert.match(fs.readFileSync(path.join(repositoryRoot, '.vscodeignore'), 'utf8'), /^test\/\*\*$/m);
});

test('vendored Compiler Explorer sources are reported only when they differ from upstream', async () => {
	const { checkVendoredFiles } = (await import('../scripts/vendor-check.mjs')) as {
		checkVendoredFiles: (
			revision: string,
			read: (revision: string, upstreamPath: string) => Promise<string>,
		) => Promise<string[]>;
	};

	const matching = await checkVendoredFiles('deadbeef', (_revision, upstreamPath) => readUpstream(upstreamPath));
	const mismatching = await checkVendoredFiles('deadbeef', (_revision, upstreamPath) =>
		upstreamPath === 'lib/parsers/asmregex.ts' ? Promise.resolve('different content') : readUpstream(upstreamPath),
	);

	assert.deepEqual(matching, []);
	assert.deepEqual(mismatching, ['src/vendor/lib/parsers/asmregex.ts']);
});

/**
 * Stands in for the upstream checkout by reading the vendored copy back.
 *
 * Docenizer scripts live outside `src/vendor`, and generated documentation
 * tables gain a local fallback return, so both are mapped back to their
 * upstream shape before the comparison.
 */
async function readUpstream(relativePath: string): Promise<string> {
	const docenizerPrefix = 'etc/scripts/docenizers/';
	if (relativePath.startsWith(docenizerPrefix)) {
		return fsPromises.readFile(
			path.join(
				repositoryRoot,
				'scripts',
				'compiler-explorer-docenizers',
				relativePath.slice(docenizerPrefix.length),
			),
			'utf8',
		);
	}
	const content = await fsPromises.readFile(path.join(repositoryRoot, 'src', 'vendor', relativePath), 'utf8');
	return relativePath.startsWith('lib/asm-docs/generated/')
		? content.replace(/\n    return undefined;\n\}\s*$/u, '\n}\n')
		: content;
}
