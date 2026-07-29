import path from 'path';
import * as vscode from 'vscode';
import { CompilationService, CompilerRegistry } from './compilation/index.js';
import { ConfigurationService } from './services/configuration-service.js';
import { getCompilerByExe } from './compilers/compiler-map.js';
import { CompilerTreeNode, CompilerTreeProvider } from './tree/compiler-tree.js';
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

	const openCompilerSettings = vscode.commands.registerCommand('coglens.AddDefaultCompileInfo', async () => {
		await vscode.commands.executeCommand('workbench.action.openSettings', 'coglens.defaultCompileInfo');
	});

	const addCompiler = vscode.commands.registerCommand('coglens.AddCompiler', async () => {
		const selection = await vscode.window.showOpenDialog({
			title: 'Select Compiler Executable',
			canSelectMany: false,
			canSelectFiles: true,
			canSelectFolders: false,
		});
		if (!selection?.[0]) {
			return;
		}
		const Adapter = getCompilerByExe(selection[0].fsPath, process.platform === 'darwin' ? 'Apple clang' : undefined);
		if (!Adapter) {
			await vscode.window.showErrorMessage(`Unsupported compiler executable: ${selection[0].fsPath}`);
			return;
		}

		const proposedName = path.basename(selection[0].fsPath, path.extname(selection[0].fsPath));
		const name = (await vscode.window.showInputBox({
			title: 'Compiler profile name',
			value: proposedName,
			validateInput: value => value.trim() ? undefined : 'A name is required',
		}))?.trim();
		if (!name) {
			return;
		}
		if (compilationService.compilerRegistry.getProfiles('user').some(profile => profile.displayName === name)) {
			await vscode.window.showWarningMessage(`A user compiler named "${name}" already exists.`);
			return;
		}

		const profile = {
			...Adapter.baseCompilerProfile(name, selection[0].fsPath),
			id: `user:${name}`,
			displayName: name,
		};
		await configuration.updateCompilers([
			...compilationService.compilerRegistry.getProfiles('user'),
			profile,
		], vscode.workspace.getWorkspaceFolder(selection[0]));
	});

	const createOverride = vscode.commands.registerCommand('coglens.CreateWorkspaceOverride', async (node?: CompilerTreeNode) => {
		if (!node?.profile || node.origin === 'user') {
			return;
		}
		const name = (await vscode.window.showInputBox({
			title: 'Workspace compiler override name',
			value: path.basename(node.profile.executable, path.extname(node.profile.executable)),
		}))?.trim();
		if (!name) {
			return;
		}
		await configuration.updateCompilers([
			...compilationService.compilerRegistry.getProfiles('user'),
			{ ...node.profile, id: `user:${name}`, displayName: name },
		], vscode.workspace.workspaceFolders?.[0]);
		logger.logChannel.info(`Created workspace compiler override "${name}".`);
	});

	context.subscriptions.push(copyText, openCompilerSettings, addCompiler, createOverride);
}

export function createCompilerTreeView(context: vscode.ExtensionContext, registry: CompilerRegistry): CompilerTreeProvider {
	const provider = new CompilerTreeProvider(registry);
	const view = vscode.window.createTreeView('coglens.compilers', { treeDataProvider: provider });
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
		compilationService.onFiltersChanged(() => provider.refresh()),
		compilationService.compilerRegistry.onDidChange(() => provider.refresh()),
		view.onDidChangeCheckboxState(event => {
			const [node] = event.items[0] ?? [];
			if (!node || typeof node.attr !== 'string') {
				return;
			}
			const filters = compilationService.globalFilterOptions as Record<string, unknown>;
			compilationService.globalFilterOptions = {
				...compilationService.globalFilterOptions,
				[node.attr]: !(filters[node.attr] ?? false),
			};
			provider.refresh();
		}),
	);

	return provider;
}
