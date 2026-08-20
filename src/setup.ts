import path from 'path';
import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import { CompilationService, ToolchainRegistry } from './compilation/index.js';
import { ConfigurationService } from './services/configuration-service.js';
import type {
	CompilationVariant,
	ManualCompilationVariantSettings,
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

export function setupCommands(
	context: vscode.ExtensionContext,
	compilationService: CompilationService,
	configuration: ConfigurationService,
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

	const settingsCommands = [
		['coglens.OpenToolchainSettingsJson', 'coglens.toolchains'],
		['coglens.OpenCompileSettingsJson', 'coglens.compileVariants'],
		['coglens.OpenArtifactSettingsJson', 'coglens.artifactOptions'],
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
			void revealActiveSource();
		}),
		vscode.window.onDidChangeActiveTextEditor(() => void revealActiveSource()),
		view.onDidChangeVisibility(event => {
			if (event.visible) {
				void revealActiveSource();
			}
		}),
	);
	void revealActiveSource();

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
	const input = await vscode.window.showInputBox({
		title,
		prompt: 'JSON array; each item is passed as one argument',
		value: JSON.stringify(value),
		validateInput: candidate => validateJson(candidate, isStringArray, 'a JSON array of strings'),
	});
	return input === undefined ? undefined : JSON.parse(input) as string[];
}

async function inputStringRecord(
	title: string,
	value: Readonly<Record<string, string>>,
): Promise<Record<string, string> | undefined> {
	const input = await vscode.window.showInputBox({
		title,
		prompt: 'JSON object mapping variable names to values',
		value: JSON.stringify(value),
		validateInput: candidate => validateJson(candidate, isStringRecord, 'a JSON object with string values'),
	});
	return input === undefined ? undefined : JSON.parse(input) as Record<string, string>;
}

function validateJson(
	input: string,
	predicate: (value: unknown) => boolean,
	expected: string,
): string | undefined {
	try {
		return predicate(JSON.parse(input)) ? undefined : `Enter ${expected}`;
	} catch {
		return 'Enter valid JSON';
	}
}

function isStringArray(value: unknown): boolean {
	return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function isStringRecord(value: unknown): boolean {
	return typeof value === 'object'
		&& value !== null
		&& !Array.isArray(value)
		&& Object.values(value).every(item => typeof item === 'string');
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

export function createArtifactDetailsTreeView(
	context: vscode.ExtensionContext,
	artifacts: AsmProvider,
): ArtifactDetailsTreeProvider {
	const provider = new ArtifactDetailsTreeProvider(artifacts);
	const view = vscode.window.createTreeView('coglens.artifactDetails', {
		treeDataProvider: provider,
	});
	const followActiveEditor = (): void =>
		provider.setActiveDocument(vscode.window.activeTextEditor?.document.uri);
	context.subscriptions.push(
		view,
		vscode.window.onDidChangeActiveTextEditor(followActiveEditor),
		artifacts.onDidChangeArtifactState(snapshot => provider.acceptArtifactState(snapshot)),
		view.onDidChangeVisibility(event => {
			if (event.visible) {
				followActiveEditor();
			}
		}),
	);
	followActiveEditor();
	return provider;
}
