import * as vscode from 'vscode';
import type { ArtifactDocumentProvider } from '../artifact-document/artifact-document-provider.js';
import type { CompilationService, ToolchainRegistry } from '../compilation/index.js';
import type { ConfigurationService } from '../services/configuration-service.js';
import { ArtifactDetailsTreeProvider } from '../tree/artifact-details-tree.js';
import { ArtifactPresetsTreeProvider } from '../tree/artifact-presets-tree.js';
import { CompilationInfoTreeProvider } from '../tree/compilation-info-tree.js';
import { GlobalOptionsTreeProvider } from '../tree/global-options-tree.js';
import { ToolchainTreeProvider } from '../tree/toolchain-tree.js';
import { activeFileUri } from '../commands/variants.js';
import type { GraphPanelManager } from '../webview/graph-panel-manager.js';

export function createToolchainTreeView(
	context: vscode.ExtensionContext,
	registry: ToolchainRegistry,
): ToolchainTreeProvider {
	const provider = new ToolchainTreeProvider(registry);
	const view = vscode.window.createTreeView('coglens.toolchains', { treeDataProvider: provider });
	context.subscriptions.push(
		view,
		registry.onDidChange(() => provider.refresh()),
	);
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
	context.subscriptions.push(
		view,
		vscode.commands.registerCommand('coglens.RevealActiveSource', revealActiveSource),
		compilationService.onVariantsChanged(() => provider.refresh()),
		compilationService.onVariantSelectionChanged(() => provider.refresh()),
	);
	return provider;
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
		compilationService.onVariantSelectionChanged(() => provider.refresh()),
		compilationService.onArtifactOptionsChanged(() => provider.refresh()),
		compilationService.toolchainRegistry.onDidChange(() => provider.refresh()),
		view.onDidChangeCheckboxState((event) => {
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
	artifacts: ArtifactDocumentProvider,
	graphs?: GraphPanelManager,
): ArtifactDetailsTreeProvider {
	const provider = new ArtifactDetailsTreeProvider(artifacts);
	const view = vscode.window.createTreeView('coglens.artifactDetails', { treeDataProvider: provider });
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
		artifacts.onDidChangeArtifactState((snapshot) => provider.acceptArtifactState(snapshot)),
		...(graphs
			? [
					graphs.onDidChangeActiveGraph((snapshot) => {
						if (snapshot) {
							provider.setActiveSnapshot(snapshot);
						} else {
							followActiveEditor();
						}
					}),
				]
			: []),
		view.onDidChangeVisibility((event) => {
			if (event.visible) {
				followActiveEditor();
			}
		}),
	);
	followActiveEditor();
	return provider;
}
