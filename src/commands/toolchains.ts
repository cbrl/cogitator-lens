import path from 'path';
import * as vscode from 'vscode';
import type { CompilationService } from '../compilation/index.js';
import * as logger from '../logger.js';
import type { ConfigurationService } from '../services/configuration-service.js';
import type { PathToolchainProvider } from '../buildsystems/path-toolchains.js';
import { createToolchainProfile, detectToolchainDefinition } from '../toolchains/toolchain-map.js';
import type { ToolchainTreeNode } from '../tree/toolchain-tree.js';

export interface ToolchainCommandDependencies {
	readonly compilationService: CompilationService;
	readonly configuration: ConfigurationService;
	readonly pathToolchains: PathToolchainProvider;
}

export function register(context: vscode.ExtensionContext, deps: ToolchainCommandDependencies): void {
	const { compilationService, configuration, pathToolchains } = deps;
	context.subscriptions.push(
		vscode.commands.registerCommand('coglens.DetectToolchains', async () => {
			if (!configuration.getDetectToolchainsOnPath()) {
				const choice = await vscode.window.showInformationMessage(
					'Detection on PATH is turned off.',
					'Open Setting',
				);
				if (choice) {
					await vscode.commands.executeCommand(
						'workbench.action.openSettings',
						'coglens.detectToolchainsOnPath',
					);
				}
				return;
			}
			await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Window, title: 'Looking for toolchains on PATH' },
				() => pathToolchains.refresh(),
			);
			const found = compilationService.toolchainRegistry.getProfiles('path');
			await vscode.window.showInformationMessage(
				found.length > 0
					? `Found on PATH: ${found.map((profile) => profile.displayName).join(', ')}.`
					: 'No supported compilers or interpreters were found on PATH.',
			);
		}),
		vscode.commands.registerCommand('coglens.AddToolchain', async () => {
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
			const name = (
				await vscode.window.showInputBox({
					title: 'Toolchain profile name',
					value: proposedName,
					validateInput: (value) => (value.trim() ? undefined : 'A name is required'),
				})
			)?.trim();
			if (!name) {
				return;
			}
			if (
				compilationService.toolchainRegistry.getProfiles('user').some((profile) => profile.displayName === name)
			) {
				await vscode.window.showWarningMessage(`A user toolchain named "${name}" already exists.`);
				return;
			}
			const profile = createToolchainProfile(detected.kind, name, selection[0].fsPath, { id: name });
			await configuration.updateToolchains(
				[...compilationService.toolchainRegistry.getProfiles('user'), profile],
				vscode.workspace.getWorkspaceFolder(selection[0]),
			);
		}),
		vscode.commands.registerCommand('coglens.DeleteToolchain', async (node?: ToolchainTreeNode) => {
			if (!node?.profile || node.origin !== 'user') {
				return;
			}
			const confirmation = await vscode.window.showWarningMessage(
				`Delete the workspace toolchain "${node.profile.displayName}"?`,
				{ modal: true },
				'Delete',
			);
			if (confirmation === 'Delete') {
				await configuration.updateToolchains(
					compilationService.toolchainRegistry
						.getProfiles('user')
						.filter((profile) => profile.id !== node.profile?.id),
				);
			}
		}),
		vscode.commands.registerCommand('coglens.CreateWorkspaceOverride', async (node?: ToolchainTreeNode) => {
			if (!node?.profile || node.origin === 'user') {
				return;
			}
			const name = (
				await vscode.window.showInputBox({
					title: 'Workspace toolchain override name',
					value: path.basename(node.profile.executable, path.extname(node.profile.executable)),
				})
			)?.trim();
			if (!name) {
				return;
			}
			await configuration.updateToolchains(
				[
					...compilationService.toolchainRegistry.getProfiles('user'),
					{ ...node.profile, id: name, displayName: name },
				],
				vscode.workspace.workspaceFolders?.[0],
			);
			logger.logChannel.info(`Created workspace toolchain override "${name}".`);
		}),
	);
}
