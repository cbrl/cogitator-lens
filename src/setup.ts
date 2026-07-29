import path from 'path';
import * as vscode from 'vscode';
import { CompilationService, ToolchainRegistry } from './compilation/index.js';
import { ConfigurationService } from './services/configuration-service.js';
import {
	createToolchainProfile,
	detectToolchainDefinition,
} from './toolchains/toolchain-map.js';
import { ToolchainTreeNode, ToolchainTreeProvider } from './tree/toolchain-tree.js';
import { CompilationInfoTreeProvider } from './tree/compilation-info-tree.js';
import { GlobalOptionsTreeProvider } from './tree/global-options-tree.js';
import { TreeNode } from './tree/treedata.js';
import * as logger from './logger.js';

export function setupCommands(
	context: vscode.ExtensionContext,
	compilationService: CompilationService,
	configuration: ConfigurationService,
): void {
	const copyText = vscode.commands.registerCommand('coglens.CopyText', async (node?: TreeNode) => {
		if (node?.label) {
			await vscode.env.clipboard.writeText(node.label);
		}
	});

	const openToolchainSettings = vscode.commands.registerCommand('coglens.AddDefaultCompileInfo', async () => {
		await vscode.commands.executeCommand('workbench.action.openSettings', 'coglens.defaultCompileInfo');
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

	context.subscriptions.push(copyText, openToolchainSettings, addToolchain, createOverride);
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
	context.subscriptions.push(view, compilationService.onVariantsChanged(() => provider.refresh()));

	return provider;
}

export function createGlobalOptionsTreeView(
	context: vscode.ExtensionContext,
	compilationService: CompilationService,
): GlobalOptionsTreeProvider {
	const provider = new GlobalOptionsTreeProvider(compilationService);
	const view = vscode.window.createTreeView('coglens.globalOptions', { treeDataProvider: provider });

	context.subscriptions.push(
		view,
		vscode.window.onDidChangeActiveTextEditor(() => provider.refresh()),
		compilationService.onVariantsChanged(() => provider.refresh()),
		compilationService.onArtifactOptionsChanged(() => provider.refresh()),
		compilationService.toolchainRegistry.onDidChange(() => provider.refresh()),
		view.onDidChangeCheckboxState(event => {
			const [node, state] = event.items[0] ?? [];
			if (!node?.optionId) {
				return;
			}
			compilationService.setArtifactOption(
				node.optionId,
				state === vscode.TreeItemCheckboxState.Checked,
			);
			provider.refresh();
		}),
	);

	return provider;
}
