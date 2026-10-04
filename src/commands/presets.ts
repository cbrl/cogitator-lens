import * as vscode from 'vscode';
import type { ArtifactDocumentProvider } from '../artifact-document/artifact-document-provider.js';
import { artifactDefinitions, supportedArtifactKinds } from '../artifacts/core/artifact-definitions.js';
import type { ArtifactPreset } from '../artifacts/ui/presets.js';
import type { CompilationService } from '../compilation/index.js';
import type { ConfigurationService } from '../services/configuration-service.js';
import { activeConfigurationScope, type ArtifactPresetTreeNode } from '../tree/artifact-presets-tree.js';
import type { ArtifactKind, ProductionOptions } from '../types/index.js';
import { inputStringArray, pickFrom } from '../ui/quick-input.js';

export interface PresetCommandDependencies {
	readonly compilationService: CompilationService;
	readonly configuration: ConfigurationService;
	readonly artifacts: ArtifactDocumentProvider;
}

export function register(context: vscode.ExtensionContext, deps: PresetCommandDependencies): void {
	const { compilationService, configuration, artifacts } = deps;
	context.subscriptions.push(
		vscode.commands.registerCommand('coglens.AddArtifactPreset', async (node?: ArtifactPresetTreeNode) => {
			await configureArtifactPreset(
				node?.scope ?? activeConfigurationScope(),
				undefined,
				compilationService,
				configuration,
			);
		}),
		vscode.commands.registerCommand('coglens.EditArtifactPreset', async (node?: ArtifactPresetTreeNode) => {
			if (node?.preset) {
				await configureArtifactPreset(node.scope, node.preset, compilationService, configuration);
			}
		}),
		vscode.commands.registerCommand('coglens.DeleteArtifactPreset', async (node?: ArtifactPresetTreeNode) => {
			if (!node?.preset) {
				return;
			}
			const confirmation = await vscode.window.showWarningMessage(
				`Delete the artifact preset "${node.preset.id}"?`,
				{ modal: true },
				'Delete',
			);
			if (confirmation === 'Delete') {
				await configuration.updateArtifactPresets(
					configuration.getArtifactPresets(node.scope).filter((preset) => preset.id !== node.preset?.id),
					workspaceFolderFor(node.scope),
				);
			}
		}),
		vscode.commands.registerCommand('coglens.SaveArtifactOptionsAsPreset', async () =>
			saveActiveArtifactAsPreset(artifacts, compilationService, configuration),
		),
	);
}

async function configureArtifactPreset(
	scope: vscode.Uri | undefined,
	existing: ArtifactPreset | undefined,
	compilationService: CompilationService,
	configuration: ConfigurationService,
): Promise<void> {
	const configured = configuration.getArtifactPresets(scope);
	const id = (
		await vscode.window.showInputBox({
			title: existing ? 'Edit Artifact Preset' : 'Add Artifact Preset',
			prompt: 'Preset name',
			value: existing?.id,
			validateInput: (value) => validatePresetName(value, configured, existing?.id),
		})
	)?.trim();
	if (!id) {
		return;
	}
	const artifactKind = await pickArtifactKind(existing?.artifactKind);
	if (!artifactKind) {
		return;
	}
	const extraArguments = await inputStringArray('Preset Compiler Arguments', existing?.extraArguments ?? []);
	if (!extraArguments) {
		return;
	}
	const productionOptions = await pickProductionOptions(
		artifactKind,
		existing?.productionOptions ?? compilationService.getArtifactOptions(artifactKind).production,
	);
	if (!productionOptions) {
		return;
	}
	await upsertArtifactPreset(configuration, scope, existing?.id, {
		id,
		artifactKind,
		extraArguments,
		productionOptions,
	});
}

async function pickArtifactKind(selected?: ArtifactKind): Promise<ArtifactKind | undefined> {
	return pickFrom(
		supportedArtifactKinds,
		(kind) => ({
			label: artifactDefinitions[kind].label,
			description: kind === selected ? 'current' : undefined,
		}),
		{ title: 'Artifact kind', placeHolder: 'Select the artifact this preset produces' },
	);
}

async function pickProductionOptions(
	kind: ArtifactKind,
	current: Partial<ProductionOptions>,
): Promise<Partial<ProductionOptions> | undefined> {
	const descriptors = artifactDefinitions[kind].options.filter((descriptor) => descriptor.group === 'production');
	if (!descriptors.length) {
		return {};
	}
	const selected = await vscode.window.showQuickPick(
		descriptors.map((descriptor) => ({
			label: descriptor.label,
			detail: descriptor.description,
			picked: current[descriptor.id as keyof ProductionOptions] ?? false,
			id: descriptor.id as keyof ProductionOptions,
		})),
		{
			title: `${artifactDefinitions[kind].label} Production Options`,
			placeHolder: 'Select the options that should be enabled',
			canPickMany: true,
		},
	);
	if (!selected) {
		return undefined;
	}
	const enabled = new Set(selected.map((item) => item.id));
	return Object.fromEntries(
		descriptors.map((descriptor) => [descriptor.id, enabled.has(descriptor.id as keyof ProductionOptions)]),
	) as Partial<ProductionOptions>;
}

async function saveActiveArtifactAsPreset(
	artifacts: ArtifactDocumentProvider,
	compilationService: CompilationService,
	configuration: ConfigurationService,
): Promise<void> {
	const snapshot = artifacts.getActiveArtifactDocumentState();
	if (!snapshot) {
		await vscode.window.showInformationMessage('Focus an open text artifact to save its options.');
		return;
	}
	const source = vscode.Uri.parse(snapshot.identity.sourceUri);
	const configured = configuration.getArtifactPresets(source);
	const id = (
		await vscode.window.showInputBox({
			title: 'Save Current Artifact Options as Preset',
			prompt: 'Preset name',
			validateInput: (value) => validatePresetName(value, configured),
		})
	)?.trim();
	if (!id) {
		return;
	}
	const inherited = compilationService.getArtifactPreset(
		snapshot.identity.artifactKind,
		snapshot.identity.presetId,
		source,
	);
	await upsertArtifactPreset(configuration, source, undefined, {
		id,
		artifactKind: snapshot.identity.artifactKind,
		extraArguments: [...(inherited?.extraArguments ?? [])],
		productionOptions: {
			...compilationService.getArtifactOptions(snapshot.identity.artifactKind).production,
			...inherited?.productionOptions,
		},
	});
	await vscode.window.showInformationMessage(`Saved artifact preset "${id}".`);
}

function validatePresetName(
	value: string,
	configured: readonly ArtifactPreset[],
	currentId?: string,
): string | undefined {
	const normalized = value.trim();
	if (!normalized) {
		return 'A name is required';
	}
	if (normalized === 'default') {
		return 'The default preset is built in';
	}
	return normalized !== currentId && configured.some((preset) => preset.id === normalized)
		? 'A preset with this name already exists'
		: undefined;
}

async function upsertArtifactPreset(
	configuration: ConfigurationService,
	scope: vscode.Uri | undefined,
	previousId: string | undefined,
	preset: ArtifactPreset,
): Promise<void> {
	await configuration.updateArtifactPresets(
		[
			...configuration
				.getArtifactPresets(scope)
				.filter((candidate) => candidate.id !== previousId && candidate.id !== preset.id),
			preset,
		],
		workspaceFolderFor(scope),
	);
}

function workspaceFolderFor(scope: vscode.Uri | undefined): vscode.WorkspaceFolder | undefined {
	return scope ? vscode.workspace.getWorkspaceFolder(scope) : vscode.workspace.workspaceFolders?.[0];
}
