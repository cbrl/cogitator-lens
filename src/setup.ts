import path from 'path';
import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import { CompilationService, ToolchainRegistry } from './compilation/index.js';
import { ConfigurationService } from './services/configuration-service.js';
import type {
	ArtifactKind,
	CompilationVariant,
	ManualCompilationVariantSettings,
	ProductionOptions,
	ToolchainProfile,
} from './types/index.js';
import {
	createToolchainProfile,
	detectToolchainDefinition,
} from './toolchains/toolchain-map.js';
import { ToolchainTreeNode, ToolchainTreeProvider } from './tree/toolchain-tree.js';
import {
	CompilationInfoTreeNode,
	CompilationInfoTreeProvider,
} from './tree/compilation-info-tree.js';
import { GlobalOptionsTreeProvider } from './tree/global-options-tree.js';
import { ArtifactDetailsTreeProvider } from './tree/artifact-details-tree.js';
import type { AsmProvider } from './asm-document/asm-provider.js';
import { TreeNode } from './tree/treedata.js';
import * as logger from './logger.js';
import type { GraphPanelManager } from './webview/graph-panel-manager.js';
import {
	ArtifactPresetsTreeProvider,
	ArtifactPresetTreeNode,
	activeConfigurationScope,
} from './tree/artifact-presets-tree.js';
import { artifactDefinitions, supportedArtifactKinds } from './artifacts/core/artifact-definitions.js';
import type { ArtifactPreset } from './artifacts/ui/presets.js';

export function setupCommands(
	context: vscode.ExtensionContext,
	compilationService: CompilationService,
	configuration: ConfigurationService,
	artifacts: AsmProvider,
): void {
	const copyText = vscode.commands.registerCommand('coglens.CopyText', async (node?: TreeNode) => {
		const text = node?.copyText ?? node?.label;
		if (text !== undefined) {
			await vscode.env.clipboard.writeText(text);
		}
	});

	const addToolchain = vscode.commands.registerCommand('coglens.AddToolchain', async () => {
		const selection = await vscode.window.showOpenDialog({
			title: 'Select Toolchain Executable',
			canSelectMany: false,
			canSelectFiles: true,
			canSelectFolders: false,
		});
		if (!selection?.[0]) {
			return;
		}
		const detected = detectToolchainDefinition(
			selection[0].fsPath,
			process.platform === 'darwin' ? 'Apple clang' : undefined,
		);
		if (!detected) {
			await vscode.window.showErrorMessage(`Unsupported toolchain executable: ${selection[0].fsPath}`);
			return;
		}

		const proposedName = path.basename(selection[0].fsPath, path.extname(selection[0].fsPath));
		const name = (await vscode.window.showInputBox({
			title: 'Toolchain profile name',
			value: proposedName,
			validateInput: value => value.trim() ? undefined : 'A name is required',
		}))?.trim();
		if (!name) {
			return;
		}
		if (compilationService.toolchainRegistry.getProfiles('user').some(profile => profile.displayName === name)) {
			await vscode.window.showWarningMessage(`A user toolchain named "${name}" already exists.`);
			return;
		}

		const profile = createToolchainProfile(detected.kind, name, selection[0].fsPath, {
			id: name,
		});
		await configuration.updateToolchains([
			...compilationService.toolchainRegistry.getProfiles('user'),
			profile,
		], vscode.workspace.getWorkspaceFolder(selection[0]));
	});

	const deleteToolchain = vscode.commands.registerCommand('coglens.DeleteToolchain', async (node?: ToolchainTreeNode) => {
		if (!node?.profile || node.origin !== 'user') {
			return;
		}
		const confirmation = await vscode.window.showWarningMessage(
			`Delete the workspace toolchain "${node.profile.displayName}"?`,
			{ modal: true },
			'Delete',
		);
		if (confirmation !== 'Delete') {
			return;
		}
		await configuration.updateToolchains(
			compilationService.toolchainRegistry.getProfiles('user')
				.filter(profile => profile.id !== node.profile?.id),
		);
	});

	const createOverride = vscode.commands.registerCommand('coglens.CreateWorkspaceOverride', async (node?: ToolchainTreeNode) => {
		if (!node?.profile || node.origin === 'user') {
			return;
		}
		const name = (await vscode.window.showInputBox({
			title: 'Workspace toolchain override name',
			value: path.basename(node.profile.executable, path.extname(node.profile.executable)),
		}))?.trim();
		if (!name) {
			return;
		}
		await configuration.updateToolchains([
			...compilationService.toolchainRegistry.getProfiles('user'),
			{ ...node.profile, id: name, displayName: name },
		], vscode.workspace.workspaceFolders?.[0]);
		logger.logChannel.info(`Created workspace toolchain override "${name}".`);
	});

	const addVariant = vscode.commands.registerCommand(
		'coglens.AddCompilationVariant',
		async (node?: CompilationInfoTreeNode) => {
			await configureManualVariant(
				node?.source ?? activeFileUri(),
				undefined,
				compilationService,
				configuration,
			);
		},
	);
	const editVariant = vscode.commands.registerCommand(
		'coglens.EditCompilationVariant',
		async (node?: CompilationInfoTreeNode) => {
			if (!node?.variant) {
				return;
			}
			await configureManualVariant(
				node.variant.source,
				node.variant,
				compilationService,
				configuration,
			);
		},
	);
	const deleteVariant = vscode.commands.registerCommand(
		'coglens.DeleteCompilationVariant',
		async (node?: CompilationInfoTreeNode) => {
			if (node?.variant?.provider !== 'manual') {
				return;
			}
			const confirmation = await vscode.window.showWarningMessage(
				`Delete the workspace variant "${node.variant.displayLabel}"?`,
				{ modal: true },
				'Delete',
			);
			if (confirmation !== 'Delete') {
				return;
			}
			await configuration.updateManualCompilationVariants(
				configuration.getManualCompilationVariants()
					.filter(variant => variant.id !== node.variant?.id),
			);
		},
	);

	const addPreset = vscode.commands.registerCommand(
		'coglens.AddArtifactPreset',
		async (node?: ArtifactPresetTreeNode) => {
			await configureArtifactPreset(
				node?.scope ?? activeConfigurationScope(),
				undefined,
				compilationService,
				configuration,
			);
		},
	);
	const editPreset = vscode.commands.registerCommand(
		'coglens.EditArtifactPreset',
		async (node?: ArtifactPresetTreeNode) => {
			if (node?.preset) {
				await configureArtifactPreset(
					node.scope,
					node.preset,
					compilationService,
					configuration,
				);
			}
		},
	);
	const deletePreset = vscode.commands.registerCommand(
		'coglens.DeleteArtifactPreset',
		async (node?: ArtifactPresetTreeNode) => {
			if (!node?.preset) {
				return;
			}
			const confirmation = await vscode.window.showWarningMessage(
				`Delete the artifact preset "${node.preset.id}"?`,
				{ modal: true },
				'Delete',
			);
			if (confirmation !== 'Delete') {
				return;
			}
			await configuration.updateArtifactPresets(
				configuration.getArtifactPresets(node.scope)
					.filter(preset => preset.id !== node.preset?.id),
				workspaceFolderFor(node.scope),
			);
		},
	);
	const saveOptionsAsPreset = vscode.commands.registerCommand(
		'coglens.SaveArtifactOptionsAsPreset',
		async () => saveActiveArtifactAsPreset(artifacts, compilationService, configuration),
	);

	const refreshArtifact = vscode.commands.registerCommand('coglens.RefreshArtifact', async () => {
		if (!artifacts.refreshActiveArtifact()) {
			await vscode.window.showInformationMessage('Focus an open text artifact to refresh it.');
		}
	});
	const cancelGeneration = vscode.commands.registerCommand('coglens.CancelGeneration', async () => {
		if (!artifacts.cancelActiveArtifact()) {
			await vscode.window.showInformationMessage('The active artifact is not being generated.');
		}
	});
	const showLog = vscode.commands.registerCommand('coglens.ShowLog', () => logger.logChannel.show());
	const revealArtifactSource = vscode.commands.registerCommand(
		'coglens.RevealArtifactSource',
		async () => {
			const snapshot = artifacts.getActiveArtifactDocumentState();
			if (snapshot) {
				await vscode.window.showTextDocument(vscode.Uri.parse(snapshot.identity.sourceUri), {
					preview: false,
				});
			}
		},
	);
	const showArtifactStatus = vscode.commands.registerCommand(
		'coglens.ShowArtifactStatus',
		async () => showArtifactStatusActions(artifacts),
	);

	const settingsCommands = [
		['coglens.OpenToolchainSettingsJson', 'coglens.toolchains'],
		['coglens.OpenCompileSettingsJson', 'coglens.compileVariants'],
		['coglens.OpenArtifactSettingsJson', 'coglens.artifactOptions'],
		['coglens.OpenPresetSettingsJson', 'coglens.artifactPresets'],
	].map(([command, key]) =>
		vscode.commands.registerCommand(command, () => openWorkspaceSettingsJson(key)));

	context.subscriptions.push(
		copyText,
		addToolchain,
		deleteToolchain,
		createOverride,
		addVariant,
		editVariant,
		deleteVariant,
		addPreset,
		editPreset,
		deletePreset,
		saveOptionsAsPreset,
		refreshArtifact,
		cancelGeneration,
		showLog,
		revealArtifactSource,
		showArtifactStatus,
		...settingsCommands,
	);
}

export function createToolchainTreeView(context: vscode.ExtensionContext, registry: ToolchainRegistry): ToolchainTreeProvider {
	const provider = new ToolchainTreeProvider(registry);
	const view = vscode.window.createTreeView('coglens.toolchains', { treeDataProvider: provider });
	context.subscriptions.push(view, registry.onDidChange(() => provider.refresh()));

	return provider;
}

export function createCompilationInfoTreeView(
	context: vscode.ExtensionContext,
	compilationService: CompilationService,
): CompilationInfoTreeProvider {
	const provider = new CompilationInfoTreeProvider(compilationService);
	const view = vscode.window.createTreeView('coglens.compileInfo', { treeDataProvider: provider });
	const revealActiveSource = async (): Promise<void> => {
		const source = activeFileUri();
		if (!source) {
			return;
		}
		const node = provider.findSource(source);
		if (!node) {
			return;
		}
		try {
			await view.reveal(node, { select: true, focus: false, expand: true });
		} catch {
			// A simultaneous provider refresh can invalidate a reveal target.
		}
	};
	const revealCommand = vscode.commands.registerCommand(
		'coglens.RevealActiveSource',
		revealActiveSource,
	);
	context.subscriptions.push(
		view,
		revealCommand,
		compilationService.onVariantsChanged(() => {
			provider.refresh();
		}),
	);

	return provider;
}

async function configureManualVariant(
	initialSource: vscode.Uri | undefined,
	existing: CompilationVariant | undefined,
	compilationService: CompilationService,
	configuration: ConfigurationService,
): Promise<void> {
	const source = initialSource ?? await pickSourceFile();
	if (!source) {
		return;
	}
	const profiles = [...compilationService.toolchainRegistry.getProfiles()]
		.sort((left, right) => left.displayName.localeCompare(right.displayName));
	if (!profiles.length) {
		await vscode.window.showWarningMessage(
			'Add or discover a toolchain before creating a compilation variant.',
		);
		return;
	}

	const displayLabel = (await vscode.window.showInputBox({
		title: existing?.provider === 'manual'
			? 'Edit Workspace Compilation Variant'
			: existing ? 'Create Workspace Variant from Discovered Variant' : 'Add Workspace Compilation Variant',
		prompt: 'Variant name',
		value: existing?.displayLabel ?? 'Workspace',
		validateInput: value => value.trim() ? undefined : 'A name is required',
	}))?.trim();
	if (!displayLabel) {
		return;
	}

	const profile = await pickToolchainProfile(profiles, existing?.toolchainProfileId);
	if (!profile) {
		return;
	}
	const workingDirectory = (await vscode.window.showInputBox({
		title: 'Working Directory',
		value: existing?.workingDirectory
			?? vscode.workspace.getWorkspaceFolder(source)?.uri.fsPath
			?? path.dirname(source.fsPath),
		validateInput: value => value.trim() ? undefined : 'A working directory is required',
	}))?.trim();
	if (!workingDirectory) {
		return;
	}
	const args = await inputStringArray('Compiler Arguments', existing?.arguments ?? []);
	if (!args) {
		return;
	}
	const environment = await inputStringRecord(
		'Environment Variables',
		existing?.environment ?? {},
	);
	if (!environment) {
		return;
	}

	const setting: ManualCompilationVariantSettings = {
		id: existing?.provider === 'manual' ? existing.id : `manual:${randomUUID()}`,
		source: source.fsPath,
		displayLabel,
		toolchainProfileId: profile.id,
		workingDirectory,
		arguments: args,
		environment,
		project: existing?.project,
		target: existing?.target,
		configuration: existing?.configuration,
	};
	const variants = configuration.getManualCompilationVariants();
	const index = variants.findIndex(variant => variant.id === setting.id);
	if (index >= 0) {
		variants[index] = setting;
	} else {
		variants.push(setting);
	}
	await configuration.updateManualCompilationVariants(variants);
	await compilationService.selectVariant(source, setting.id);
}

async function pickToolchainProfile(
	profiles: readonly ToolchainProfile[],
	selectedId: string | undefined,
): Promise<ToolchainProfile | undefined> {
	const selected = profiles.find(profile => profile.id === selectedId);
	const choice = await vscode.window.showQuickPick(
		profiles.map(profile => ({
			label: profile.displayName,
			description: profile.kind,
			detail: profile.executable,
			profile,
		})),
		{
			title: 'Toolchain',
			placeHolder: selected
				? `Current: ${selected.displayName}`
				: 'Select the toolchain for this variant',
			matchOnDescription: true,
			matchOnDetail: true,
		},
	);
	return choice?.profile;
}

async function inputStringArray(
	title: string,
	value: readonly string[],
): Promise<string[] | undefined> {
	const result = [...value];
	while (true) {
		const choice = await vscode.window.showQuickPick([
			{ label: '$(check) Done', action: 'done' as const },
			{ label: '$(add) Add argument', action: 'add' as const },
			...result.map((argument, index) => ({
				label: argument || '(empty argument)',
				description: `Argument ${index + 1}`,
				action: 'item' as const,
				index,
			})),
		], {
			title,
			placeHolder: 'Add, edit, remove, or reorder compiler arguments',
			matchOnDescription: true,
		});
		if (!choice) {
			return undefined;
		}
		if (choice.action === 'done') {
			return result;
		}
		if (choice.action === 'add') {
			const argument = await vscode.window.showInputBox({
				title: `${title}: Add argument`,
				prompt: 'This value is passed as one compiler argument',
			});
			if (argument !== undefined) {
				result.push(argument);
			}
			continue;
		}
		const index = choice.index;
		const action = await vscode.window.showQuickPick([
			{ label: '$(edit) Edit', action: 'edit' as const },
			...(index > 0 ? [{ label: '$(arrow-up) Move up', action: 'up' as const }] : []),
			...(index < result.length - 1
				? [{ label: '$(arrow-down) Move down', action: 'down' as const }]
				: []),
			{ label: '$(trash) Remove', action: 'remove' as const },
		], { title: `${title}: ${result[index] || '(empty argument)'}` });
		switch (action?.action) {
			case 'edit': {
				const argument = await vscode.window.showInputBox({
					title: `${title}: Edit argument`,
					value: result[index],
				});
				if (argument !== undefined) {
					result[index] = argument;
				}
				break;
			}
			case 'up':
				[result[index - 1], result[index]] = [result[index], result[index - 1]];
				break;
			case 'down':
				[result[index], result[index + 1]] = [result[index + 1], result[index]];
				break;
			case 'remove':
				result.splice(index, 1);
				break;
		}
	}
}

async function inputStringRecord(
	title: string,
	value: Readonly<Record<string, string>>,
): Promise<Record<string, string> | undefined> {
	const result = { ...value };
	while (true) {
		const entries = Object.entries(result);
		const choice = await vscode.window.showQuickPick([
			{ label: '$(check) Done', action: 'done' as const },
			{ label: '$(add) Add variable', action: 'add' as const },
			...entries.map(([name, variableValue]) => ({
				label: name,
				description: variableValue,
				action: 'item' as const,
				name,
			})),
		], {
			title,
			placeHolder: 'Add, edit, or remove environment variables',
			matchOnDescription: true,
		});
		if (!choice) {
			return undefined;
		}
		if (choice.action === 'done') {
			return result;
		}
		if (choice.action === 'add') {
			const entry = await inputEnvironmentEntry(title, result);
			if (entry) {
				result[entry.name] = entry.value;
			}
			continue;
		}
		const action = await vscode.window.showQuickPick([
			{ label: '$(edit) Edit', action: 'edit' as const },
			{ label: '$(trash) Remove', action: 'remove' as const },
		], { title: `${title}: ${choice.name}` });
		if (action?.action === 'remove') {
			delete result[choice.name];
		} else if (action?.action === 'edit') {
			const entry = await inputEnvironmentEntry(title, result, choice.name);
			if (entry) {
				delete result[choice.name];
				result[entry.name] = entry.value;
			}
		}
	}
}

async function inputEnvironmentEntry(
	title: string,
	existing: Readonly<Record<string, string>>,
	previousName?: string,
): Promise<{ name: string; value: string } | undefined> {
	const name = (await vscode.window.showInputBox({
		title: `${title}: Variable name`,
		value: previousName,
		validateInput: candidate => {
			const normalized = candidate.trim();
			if (!normalized) {
				return 'A variable name is required';
			}
			return normalized !== previousName && Object.hasOwn(existing, normalized)
				? 'A variable with this name already exists'
				: undefined;
		},
	}))?.trim();
	if (!name) {
		return undefined;
	}
	const variableValue = await vscode.window.showInputBox({
		title: `${title}: ${name}`,
		prompt: 'Environment variable value',
		value: previousName ? existing[previousName] : '',
	});
	return variableValue === undefined ? undefined : { name, value: variableValue };
}

async function configureArtifactPreset(
	scope: vscode.Uri | undefined,
	existing: ArtifactPreset | undefined,
	compilationService: CompilationService,
	configuration: ConfigurationService,
): Promise<void> {
	const configured = configuration.getArtifactPresets(scope);
	const id = (await vscode.window.showInputBox({
		title: existing ? 'Edit Artifact Preset' : 'Add Artifact Preset',
		prompt: 'Preset name',
		value: existing?.id,
		validateInput: value => {
			const normalized = value.trim();
			if (!normalized) {
				return 'A name is required';
			}
			if (normalized === 'default') {
				return 'The default preset is built in';
			}
			return normalized !== existing?.id && configured.some(preset => preset.id === normalized)
				? 'A preset with this name already exists'
				: undefined;
		},
	}))?.trim();
	if (!id) {
		return;
	}
	const artifactKind = await pickArtifactKind(existing?.artifactKind);
	if (!artifactKind) {
		return;
	}
	const extraArguments = await inputStringArray(
		'Preset Compiler Arguments',
		existing?.extraArguments ?? [],
	);
	if (!extraArguments) {
		return;
	}
	const productionOptions = await pickProductionOptions(
		artifactKind,
		existing?.productionOptions
			?? compilationService.getArtifactOptions(artifactKind).production,
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
	const choice = await vscode.window.showQuickPick(
		supportedArtifactKinds.map(kind => ({
			label: artifactDefinitions[kind].label,
			description: kind === selected ? 'current' : undefined,
			artifactKind: kind,
		})),
		{ title: 'Artifact kind', placeHolder: 'Select the artifact this preset produces' },
	);
	return choice?.artifactKind;
}

async function pickProductionOptions(
	kind: ArtifactKind,
	current: Partial<ProductionOptions>,
): Promise<Partial<ProductionOptions> | undefined> {
	const descriptors = artifactDefinitions[kind].options
		.filter(descriptor => descriptor.group === 'production');
	if (!descriptors.length) {
		return {};
	}
	const selected = await vscode.window.showQuickPick(
		descriptors.map(descriptor => ({
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
	const enabled = new Set(selected.map(item => item.id));
	return Object.fromEntries(descriptors.map(descriptor => [
		descriptor.id,
		enabled.has(descriptor.id as keyof ProductionOptions),
	])) as Partial<ProductionOptions>;
}

async function saveActiveArtifactAsPreset(
	artifacts: AsmProvider,
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
	const id = (await vscode.window.showInputBox({
		title: 'Save Current Artifact Options as Preset',
		prompt: 'Preset name',
		validateInput: value => {
			const normalized = value.trim();
			if (!normalized) {
				return 'A name is required';
			}
			if (normalized === 'default') {
				return 'The default preset is built in';
			}
			return configured.some(preset => preset.id === normalized)
				? 'A preset with this name already exists'
				: undefined;
		},
	}))?.trim();
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

async function upsertArtifactPreset(
	configuration: ConfigurationService,
	scope: vscode.Uri | undefined,
	previousId: string | undefined,
	preset: ArtifactPreset,
): Promise<void> {
	await configuration.updateArtifactPresets([
		...configuration.getArtifactPresets(scope)
			.filter(candidate => candidate.id !== previousId && candidate.id !== preset.id),
		preset,
	], workspaceFolderFor(scope));
}

function workspaceFolderFor(scope: vscode.Uri | undefined): vscode.WorkspaceFolder | undefined {
	return scope ? vscode.workspace.getWorkspaceFolder(scope) : vscode.workspace.workspaceFolders?.[0];
}

async function showArtifactStatusActions(artifacts: AsmProvider): Promise<void> {
	const snapshot = artifacts.getActiveArtifactDocumentState();
	if (!snapshot) {
		return;
	}
	const choice = await vscode.window.showQuickPick([
		{
			label: '$(refresh) Refresh Artifact',
			description: 'Regenerate from the current source and settings',
			command: 'coglens.RefreshArtifact',
		},
		...(snapshot.status.state === 'compiling' ? [{
			label: '$(debug-stop) Cancel Generation',
			description: 'Stop the active compilation',
			command: 'coglens.CancelGeneration',
		}] : []),
		{
			label: '$(go-to-file) Reveal Source',
			description: path.basename(snapshot.identity.sourceLabel),
			command: 'coglens.RevealArtifactSource',
		},
		{
			label: '$(output) Show Log',
			description: 'Open the Cogitator Lens output channel',
			command: 'coglens.ShowLog',
		},
	], {
		title: `${snapshot.identity.artifactLabel} · ${statusLabel(snapshot.status.state)}`,
		matchOnDescription: true,
	});
	if (choice) {
		await vscode.commands.executeCommand(choice.command);
	}
}

function statusLabel(state: import('./asm-document/compile-handler.js').CompilationDocumentState): string {
	return state[0].toUpperCase() + state.slice(1);
}

function activeFileUri(): vscode.Uri | undefined {
	const uri = vscode.window.activeTextEditor?.document.uri;
	return uri?.scheme === 'file' ? uri : undefined;
}

async function pickSourceFile(): Promise<vscode.Uri | undefined> {
	const selection = await vscode.window.showOpenDialog({
		title: 'Select Source File',
		canSelectMany: false,
		canSelectFiles: true,
		canSelectFolders: false,
	});
	return selection?.[0];
}

async function openWorkspaceSettingsJson(key: string): Promise<void> {
	const command = vscode.workspace.workspaceFile || vscode.workspace.workspaceFolders?.length
		? 'workbench.action.openWorkspaceSettingsFile'
		: 'workbench.action.openSettingsJson';
	await vscode.commands.executeCommand(command, {
		revealSetting: { key, edit: true },
	});
}

export function createGlobalOptionsTreeView(
	context: vscode.ExtensionContext,
	compilationService: CompilationService,
): GlobalOptionsTreeProvider {
	const provider = new GlobalOptionsTreeProvider(compilationService);
	const view = vscode.window.createTreeView('coglens.artifactOptions', { treeDataProvider: provider });

	context.subscriptions.push(
		view,
		vscode.window.onDidChangeActiveTextEditor(() => provider.refresh()),
		compilationService.onVariantsChanged(() => provider.refresh()),
		compilationService.onArtifactOptionsChanged(() => provider.refresh()),
		compilationService.toolchainRegistry.onDidChange(() => provider.refresh()),
		view.onDidChangeCheckboxState(event => {
			const [node, state] = event.items[0] ?? [];
			if (!node?.optionId || !node.artifactKind) {
				return;
			}
			compilationService.setArtifactOption(
				node.artifactKind,
				node.optionId,
				state === vscode.TreeItemCheckboxState.Checked,
			);
			provider.refresh();
		}),
	);

	return provider;
}

export function createArtifactPresetsTreeView(
	context: vscode.ExtensionContext,
	configuration: ConfigurationService,
): ArtifactPresetsTreeProvider {
	const provider = new ArtifactPresetsTreeProvider(configuration);
	const view = vscode.window.createTreeView('coglens.artifactPresets', { treeDataProvider: provider });
	context.subscriptions.push(
		view,
		vscode.window.onDidChangeActiveTextEditor(() => provider.refresh()),
		configuration.onDidChange(() => provider.refresh()),
	);
	return provider;
}

export function createArtifactDetailsTreeView(
	context: vscode.ExtensionContext,
	artifacts: AsmProvider,
	graphs?: GraphPanelManager,
): ArtifactDetailsTreeProvider {
	const provider = new ArtifactDetailsTreeProvider(artifacts);
	const view = vscode.window.createTreeView('coglens.artifactDetails', {
		treeDataProvider: provider,
	});
	const followActiveEditor = (): void => {
		const graph = graphs?.activeSnapshot;
		if (graph) {
			provider.setActiveSnapshot(graph);
		} else {
			provider.setActiveDocument(vscode.window.activeTextEditor?.document.uri);
		}
	};
	context.subscriptions.push(
		view,
		vscode.window.onDidChangeActiveTextEditor(followActiveEditor),
		artifacts.onDidChangeArtifactState(snapshot => provider.acceptArtifactState(snapshot)),
		...(graphs ? [
			graphs.onDidChangeArtifactState(snapshot => provider.acceptArtifactState(snapshot)),
			graphs.onDidChangeActiveGraph(snapshot => {
				if (snapshot) {
					provider.setActiveSnapshot(snapshot);
				} else {
					followActiveEditor();
				}
			}),
		] : []),
		view.onDidChangeVisibility(event => {
			if (event.visible) {
				followActiveEditor();
			}
		}),
	);
	followActiveEditor();
	return provider;
}
