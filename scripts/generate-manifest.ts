import fs from 'node:fs';
import path from 'node:path';
import { artifactDefinitions, supportedArtifactKinds } from '../src/artifacts/core/artifact-definitions.js';
import type { ArtifactOptionDescriptor } from '../src/artifacts/core/artifact-contracts.js';
import { artifactEditorLanguages } from '../src/artifacts/core/editor-languages.js';
import { supportedToolchainKinds } from '../src/toolchains/toolchain-kinds.js';
import { defaultArtifactOptions } from '../src/types/artifact-options.js';

type JsonObject = Record<string, unknown>;

/** Replaces only manifest fragments whose source of truth is a code registry. */
export function generateManifest(manifest: JsonObject): JsonObject {
	const generated = structuredClone(manifest);
	generateEditorContributions(generated);
	const properties = configurationProperties(generated);
	const toolchains = properties['coglens.toolchains'] as JsonObject;
	const toolchainItems = toolchains.items as JsonObject;
	const toolchainProperties = toolchainItems.properties as JsonObject;
	const toolchainKind = toolchainProperties.kind as JsonObject;
	toolchainKind.enum = [...supportedToolchainKinds];

	const descriptors = collectOptionDescriptors();
	const artifactOptions = properties['coglens.artifactOptions'] as JsonObject;
	artifactOptions.default = artifactDefaults();
	artifactOptions.properties = Object.fromEntries(
		supportedArtifactKinds.map((kind) => {
			const definition = artifactDefinitions[kind];
			return [
				kind,
				{
					type: 'object',
					title: `${definition.label} options`,
					description: `${definition.label} options`,
					additionalProperties: false,
					properties: Object.fromEntries(
						definition.options.map((descriptor) => [descriptor.id, optionSchema(descriptor)]),
					),
				},
			];
		}),
	);

	const presets = properties['coglens.artifactPresets'] as JsonObject;
	const presetValue = presets.additionalProperties as JsonObject;
	const presetProperties = presetValue.properties as JsonObject;
	const artifactKind = presetProperties.artifactKind as JsonObject;
	artifactKind.enum = [...supportedArtifactKinds];
	const productionOptions = presetProperties.productionOptions as JsonObject;
	productionOptions.properties = Object.fromEntries(
		[...descriptors.values()]
			.filter((descriptor) => descriptor.group === 'production')
			.map((descriptor) => [
				descriptor.id,
				{
					type: 'boolean',
					title: descriptor.label,
					description: descriptor.description,
				},
			]),
	);
	return generated;
}

/** Rebuilds artifact-owned language and grammar contributions while preserving third-party entries. */
function generateEditorContributions(manifest: JsonObject): void {
	const contributes = manifest.contributes as JsonObject;
	const generatedIds = new Set(Object.keys(artifactEditorLanguages));
	const existingLanguages = (contributes.languages as JsonObject[] | undefined) ?? [];
	const existingGrammars = (contributes.grammars as JsonObject[] | undefined) ?? [];
	const extensions = new Map<string, string[]>();
	for (const definition of Object.values(artifactDefinitions)) {
		if (definition.editorLanguageId) {
			const values = extensions.get(definition.editorLanguageId) ?? [];
			if (!values.includes(definition.filenameExtension)) values.push(definition.filenameExtension);
			extensions.set(definition.editorLanguageId, values);
		}
	}
	contributes.languages = [
		...existingLanguages.filter((language) => !generatedIds.has(String(language.id))),
		...Object.entries(artifactEditorLanguages).map(([id, language]) => ({
			id,
			aliases: [...language.aliases],
			extensions: extensions.get(id) ?? [],
		})),
	];
	contributes.grammars = [
		...existingGrammars.filter((grammar) => !generatedIds.has(String(grammar.language))),
		...Object.entries(artifactEditorLanguages).map(([language, metadata]) => ({
			language,
			scopeName: metadata.grammar.scopeName,
			path: metadata.grammar.path,
		})),
	];
}

/** Validates that repeated option IDs describe the same setting everywhere. */
export function collectOptionDescriptors(): ReadonlyMap<string, ArtifactOptionDescriptor> {
	return validateOptionDescriptors(Object.values(artifactDefinitions));
}

/** Returns one descriptor per option ID and rejects inconsistent registry entries. */
export function validateOptionDescriptors(
	definitions: readonly { readonly options: readonly ArtifactOptionDescriptor[] }[],
): ReadonlyMap<string, ArtifactOptionDescriptor> {
	const descriptors = new Map<string, ArtifactOptionDescriptor>();
	for (const definition of definitions) {
		for (const descriptor of definition.options) {
			const existing = descriptors.get(descriptor.id);
			if (
				existing &&
				(existing.group !== descriptor.group ||
					existing.label !== descriptor.label ||
					existing.description !== descriptor.description)
			) {
				throw new Error(`Conflicting artifact option descriptor: ${descriptor.id}`);
			}
			descriptors.set(descriptor.id, descriptor);
		}
	}
	return descriptors;
}

function artifactDefaults(): JsonObject {
	return Object.fromEntries(
		supportedArtifactKinds.flatMap((kind) => {
			const values = Object.fromEntries(
				artifactDefinitions[kind].options.map((descriptor) => [
					descriptor.id,
					defaultArtifactOptions[descriptor.group][descriptor.id as never],
				]),
			);
			return Object.keys(values).length > 0 ? [[kind, values]] : [];
		}),
	);
}

function optionSchema(descriptor: ArtifactOptionDescriptor): JsonObject {
	return {
		type: 'boolean',
		title: descriptor.label,
		default: defaultArtifactOptions[descriptor.group][descriptor.id as never],
		description: descriptor.description,
	};
}

function configurationProperties(manifest: JsonObject): JsonObject {
	const contributes = manifest.contributes as JsonObject;
	const configuration = contributes.configuration as JsonObject[];
	return configuration[0].properties as JsonObject;
}

const repositoryRoot = path.resolve(__dirname, '..');
const manifestPath = path.join(repositoryRoot, 'package.json');
const mode = process.argv[2];

if (mode === '--write' || mode === '--check') {
	const currentText = fs.readFileSync(manifestPath, 'utf8');
	const current = JSON.parse(currentText) as JsonObject;
	const generatedText = `${JSON.stringify(generateManifest(current), undefined, 2)}\n`;
	if (mode === '--write') {
		fs.writeFileSync(manifestPath, generatedText, 'utf8');
	} else if (currentText !== generatedText) {
		console.error('package.json registry-derived fragments are stale. Run npm run manifest:generate.');
		process.exitCode = 1;
	}
} else if (require.main === module) {
	console.error('Usage: generate-manifest.ts --write|--check');
	process.exitCode = 2;
}
