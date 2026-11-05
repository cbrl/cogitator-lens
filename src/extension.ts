import vscode, { commands, type ExtensionContext, window, workspace } from 'vscode';
import { ActiveArtifact } from './artifact-document/active-artifact.js';
import { ArtifactDocumentProvider } from './artifact-document/artifact-document-provider.js';
import { ArtifactStatusBar } from './artifact-document/artifact-status-bar.js';
import { ArtifactDocumentRegistry } from './artifact-document/artifact-document-registry.js';
import { ArtifactNavigationProvider } from './artifact-document/artifact-navigation-provider.js';
import {
	ArtifactSemanticTokensProvider,
	artifactSemanticTokensLegend,
} from './artifact-document/artifact-semantic-tokens-provider.js';
import { CmakeVariantProvider } from './buildsystems/cmake.js';
import { CompilationDatabaseVariantProvider } from './buildsystems/compilation-database.js';
import { PathToolchainProvider } from './buildsystems/path-toolchains.js';
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
import { setProcessLimits } from './exec.js';
import { setListingLineLimit } from './compilation/listing-limit.js';
import * as logger from './logger.js';
import { GraphPanelManager } from './webview/graph-panel-manager.js';

export async function activate(context: ExtensionContext): Promise<void> {
	const configuration = new ConfigurationService();
	setProcessLimits(configuration.getProcessLimits());
	setListingLineLimit(configuration.getListingLineLimit());
	// This listener comes before the artifact registry's, so a refresh that a change starts uses the new limits.
	const limitsSubscription = configuration.onDidChange((change) => {
		if (change.affects('processTimeout') || change.affects('processOutputLimit')) {
			setProcessLimits(configuration.getProcessLimits());
		}
		if (change.affects('listingLineLimit')) {
			setListingLineLimit(configuration.getListingLineLimit());
		}
	});
	const compilationService = new CompilationService(configuration, context.workspaceState);
	const artifactRegistry = new ArtifactDocumentRegistry(compilationService, configuration);
	const artifactProvider = new ArtifactDocumentProvider(compilationService, configuration, artifactRegistry);
	const graphPanels = new GraphPanelManager(context, artifactRegistry);
	const activeArtifact = new ActiveArtifact(artifactRegistry, graphPanels);
	const statusBar = new ArtifactStatusBar(activeArtifact);
	const navigationProvider = new ArtifactNavigationProvider((uri) => artifactProvider.getRenderedArtifact(uri));

	createToolchainTreeView(context, compilationService.toolchainRegistry);
	createCompilationInfoTreeView(context, compilationService);
	createGlobalOptionsTreeView(context, compilationService);
	createArtifactPresetsTreeView(context, configuration);
	createArtifactDetailsTreeView(context, artifactProvider, graphPanels);

	const pathToolchains = new PathToolchainProvider(configuration);
	const sharedCommandDependencies = {
		compilationService,
		configuration,
		artifacts: artifactProvider,
		activeArtifact,
	};
	toolchainCommands.register(context, { ...sharedCommandDependencies, pathToolchains });
	variantCommands.register(context, sharedCommandDependencies);
	presetCommands.register(context, sharedCommandDependencies);
	artifactCommands.register(context, { ...sharedCommandDependencies, graphPanels });

	const variantProviders: VariantProvider[] = [
		new CmakeVariantProvider(),
		new CompilationDatabaseVariantProvider(configuration),
		new PythonEnvironmentVariantProvider(),
		pathToolchains,
	];
	const providerSubscriptions = variantProviders.map((provider) =>
		provider.onSnapshot((snapshot) => compilationService.reconcileProviderSnapshot(snapshot)),
	);
	context.subscriptions.push(...variantProviders, ...providerSubscriptions);
	// Activation does not wait for discovery. Requests that need variants wait for it instead, so it
	// is tracked before the content provider can be asked for an artifact tab that VS Code restores.
	compilationService.trackProviderInitialization(
		Promise.allSettled(variantProviders.map((provider) => provider.initialize())).then((results) => {
			for (const result of results) {
				if (result.status === 'rejected') {
					logger.logChannel.error(`Variant discovery failed to start: ${String(result.reason)}`);
				}
			}
		}),
	);

	const documentSelector = { scheme: ArtifactDocumentProvider.scheme };
	const contentProvider = workspace.registerTextDocumentContentProvider(
		ArtifactDocumentProvider.scheme,
		artifactProvider,
	);
	const definitionRegistration = vscode.languages.registerDefinitionProvider(documentSelector, navigationProvider);
	const linkRegistration = vscode.languages.registerDocumentLinkProvider(documentSelector, navigationProvider);
	const foldingRegistration = vscode.languages.registerFoldingRangeProvider(documentSelector, navigationProvider);
	const hoverRegistration = vscode.languages.registerHoverProvider(documentSelector, navigationProvider);
	const symbolRegistration = vscode.languages.registerDocumentSymbolProvider(documentSelector, navigationProvider);
	const semanticTokensRegistration = vscode.languages.registerDocumentSemanticTokensProvider(
		documentSelector,
		new ArtifactSemanticTokensProvider((uri) => artifactProvider.getRenderedArtifact(uri)),
		artifactSemanticTokensLegend,
	);

	// The status bar sets coglens.activeArtifact, which follows graph panels and the source of an artifact too.
	const updateEditorContexts = (): Thenable<unknown> =>
		commands.executeCommand(
			'setContext',
			'coglens.supportedSource',
			Boolean(
				window.activeTextEditor && variantCommands.isSupportedSourceDocument(window.activeTextEditor.document),
			),
		);
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
		limitsSubscription,
		configuration,
		compilationService,
		artifactRegistry,
		artifactProvider,
		graphPanels,
		activeArtifact,
		statusBar,
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
}
