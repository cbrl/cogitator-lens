import vscode, { commands, type ExtensionContext, window, workspace } from 'vscode';
import { ArtifactDocumentProvider } from './artifact-document/artifact-document-provider.js';
import { ArtifactDocumentRegistry } from './artifact-document/artifact-document-registry.js';
import { ArtifactNavigationProvider } from './artifact-document/artifact-navigation-provider.js';
import {
	ArtifactSemanticTokensProvider,
	artifactSemanticTokensLegend,
} from './artifact-document/artifact-semantic-tokens-provider.js';
import { CmakeVariantProvider } from './buildsystems/cmake.js';
import { CompilationDatabaseVariantProvider } from './buildsystems/compilation-database.js';
import { PythonEnvironmentVariantProvider } from './buildsystems/python-environments.js';
import type { VariantProvider } from './buildsystems/variant-provider.js';
import * as artifactCommands from './commands/artifacts.js';
import * as presetCommands from './commands/presets.js';
import * as toolchainCommands from './commands/toolchains.js';
import * as variantCommands from './commands/variants.js';
import { CompilationService } from './compilation/index.js';
import { ConfigurationService } from './services/configuration-service.js';
import {
	createArtifactDetailsTreeView,
	createArtifactPresetsTreeView,
	createCompilationInfoTreeView,
	createGlobalOptionsTreeView,
	createToolchainTreeView,
} from './views/index.js';
import { GraphPanelManager } from './webview/graph-panel-manager.js';

export async function activate(context: ExtensionContext): Promise<void> {
	const configuration = new ConfigurationService();
	const compilationService = new CompilationService(configuration, context.workspaceState);
	const artifactRegistry = new ArtifactDocumentRegistry(compilationService, configuration);
	const artifactProvider = new ArtifactDocumentProvider(
		compilationService, configuration, artifactRegistry,
	);
	const graphPanels = new GraphPanelManager(context, artifactRegistry);
	const navigationProvider = new ArtifactNavigationProvider(uri =>
		artifactProvider.getRenderedArtifact(uri));

	createToolchainTreeView(context, compilationService.toolchainRegistry);
	createCompilationInfoTreeView(context, compilationService);
	createGlobalOptionsTreeView(context, compilationService);
	createArtifactPresetsTreeView(context, configuration);
	createArtifactDetailsTreeView(context, artifactProvider, graphPanels);

	const sharedCommandDependencies = {
		compilationService,
		configuration,
		artifacts: artifactProvider,
	};
	toolchainCommands.register(context, sharedCommandDependencies);
	variantCommands.register(context, sharedCommandDependencies);
	presetCommands.register(context, sharedCommandDependencies);
	artifactCommands.register(context, { ...sharedCommandDependencies, graphPanels });

	const variantProviders: VariantProvider[] = [
		new CmakeVariantProvider(),
		new CompilationDatabaseVariantProvider(configuration),
		new PythonEnvironmentVariantProvider(),
	];
	const providerSubscriptions = variantProviders.map(provider =>
		provider.onSnapshot(snapshot => compilationService.reconcileProviderSnapshot(snapshot))
	);

	const documentSelector = { scheme: ArtifactDocumentProvider.scheme };
	const contentProvider = workspace.registerTextDocumentContentProvider(ArtifactDocumentProvider.scheme, artifactProvider);
	const definitionRegistration = vscode.languages.registerDefinitionProvider(documentSelector, navigationProvider);
	const linkRegistration = vscode.languages.registerDocumentLinkProvider(documentSelector, navigationProvider);
	const foldingRegistration = vscode.languages.registerFoldingRangeProvider(documentSelector, navigationProvider);
	const hoverRegistration = vscode.languages.registerHoverProvider(documentSelector, navigationProvider);
	const symbolRegistration = vscode.languages.registerDocumentSymbolProvider(documentSelector, navigationProvider);
	const semanticTokensRegistration = vscode.languages.registerDocumentSemanticTokensProvider(
		documentSelector,
		new ArtifactSemanticTokensProvider(uri => artifactProvider.getRenderedArtifact(uri)),
		artifactSemanticTokensLegend,
	);

	const updateEditorContexts = (): Thenable<unknown[]> => Promise.all([
		commands.executeCommand(
			'setContext',
			'coglens.supportedSource',
			Boolean(window.activeTextEditor
				&& artifactCommands.isSupportedSourceDocument(window.activeTextEditor.document)),
		),
		commands.executeCommand(
			'setContext',
			'coglens.artifactDocument',
			window.activeTextEditor?.document.uri.scheme === ArtifactDocumentProvider.scheme,
		),
	]);
	const activeEditorSubscription = window.onDidChangeActiveTextEditor(() => {
		void updateEditorContexts();
	});
	const openedDocumentSubscription = workspace.onDidOpenTextDocument(() => {
		void updateEditorContexts();
	});
	const closedDocumentSubscription = workspace.onDidCloseTextDocument(() => {
		void updateEditorContexts();
	});
	await updateEditorContexts();

	context.subscriptions.push(
		configuration,
		compilationService,
		artifactRegistry,
		artifactProvider,
		graphPanels,
		...variantProviders,
		...providerSubscriptions,
		contentProvider,
		definitionRegistration,
		linkRegistration,
		foldingRegistration,
		hoverRegistration,
		symbolRegistration,
		semanticTokensRegistration,
		activeEditorSubscription,
		openedDocumentSubscription,
		closedDocumentSubscription,
	);

	await Promise.all(variantProviders.map(provider => provider.initialize()));
}
