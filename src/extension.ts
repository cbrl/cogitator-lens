import vscode, {
	commands,
	ExtensionContext,
	TextDocumentShowOptions,
	ViewColumn,
	window,
	workspace,
} from 'vscode';
import { AsmDefinitionProvider } from './asm-document/asm-definition-provider.js';
import { AsmProvider, getArtifactUri } from './asm-document/asm-provider.js';
import { CmakeVariantProvider } from './buildsystems/cmake.js';
import { CompilationDatabaseVariantProvider } from './buildsystems/compilation-database.js';
import { VariantProvider } from './buildsystems/variant-provider.js';
import { CompilationService } from './compilation/index.js';
import { ConfigurationService } from './services/configuration-service.js';
import type { ArtifactKind } from './types/index.js';
import {
	artifactDefinitions,
	supportedArtifactKinds,
} from './artifacts/artifact-definitions.js';
import { supportedLanguageIdentifiers } from './toolchains/toolchain-map.js';
import * as setup from './setup.js';

export async function activate(context: ExtensionContext): Promise<void> {
	const configuration = new ConfigurationService();
	const compilationService = new CompilationService(
		configuration,
		context.workspaceState,
	);
	const artifactProvider = new AsmProvider(compilationService, configuration);
	const definitionProvider = new AsmDefinitionProvider(uri =>
		artifactProvider.getCompiledAssembly(uri));

	setup.createToolchainTreeView(context, compilationService.toolchainRegistry);
	setup.createCompilationInfoTreeView(context, compilationService);
	setup.createGlobalOptionsTreeView(context, compilationService);
	setup.setupCommands(context, compilationService, configuration);

	const variantProviders: VariantProvider[] = [
		new CmakeVariantProvider(),
		new CompilationDatabaseVariantProvider(configuration),
	];
	const providerSubscriptions = variantProviders.map(provider =>
		provider.onSnapshot(snapshot => compilationService.reconcileProviderSnapshot(snapshot)));

	const contentProvider = workspace.registerTextDocumentContentProvider(
		AsmProvider.scheme,
		artifactProvider,
	);
	const definitionRegistration = vscode.languages.registerDefinitionProvider(
		{ scheme: AsmProvider.scheme },
		definitionProvider,
	);

	const openArtifactCommand = commands.registerTextEditorCommand(
		'coglens.OpenArtifact',
		editor => openArtifact(editor, undefined, compilationService, artifactProvider),
	);

	const pickVariantCommand = commands.registerTextEditorCommand(
		'coglens.PickCompilationVariant',
		async editor => {
			if (!isSupportedSourceDocument(editor.document)) {
				return;
			}
			if (await pickVariant(editor.document.uri, compilationService)) {
				const variant = compilationService.getSelectedVariant(editor.document.uri);
				if (variant) {
					artifactProvider.requestRefresh(getArtifactUri(
						editor.document.uri,
						variant,
						'assembly',
						'default',
					));
				}
			}
		},
	);

	const updateSupportedSourceContext = (): Thenable<unknown> =>
		commands.executeCommand(
			'setContext',
			'coglens.supportedSource',
			Boolean(window.activeTextEditor
				&& isSupportedSourceDocument(window.activeTextEditor.document)),
		);
	const activeEditorSubscription = window.onDidChangeActiveTextEditor(() => {
		void updateSupportedSourceContext();
	});
	const openedDocumentSubscription = workspace.onDidOpenTextDocument(() => {
		void updateSupportedSourceContext();
	});
	const closedDocumentSubscription = workspace.onDidCloseTextDocument(() => {
		void updateSupportedSourceContext();
	});
	await updateSupportedSourceContext();

	context.subscriptions.push(
		configuration,
		compilationService,
		artifactProvider,
		...variantProviders,
		...providerSubscriptions,
		contentProvider,
		definitionRegistration,
		openArtifactCommand,
		pickVariantCommand,
		activeEditorSubscription,
		openedDocumentSubscription,
		closedDocumentSubscription,
	);

	await Promise.all(variantProviders.map(provider => provider.initialize()));
}

async function openArtifact(
	editor: vscode.TextEditor,
	requestedKind: ArtifactKind | undefined,
	compilationService: CompilationService,
	artifactProvider: AsmProvider,
): Promise<void> {
	if (!isSupportedSourceDocument(editor.document)) {
		await window.showWarningMessage(
			'Cogitator Lens supports saved, file-backed sources declared by its toolchains.',
		);
		return;
	}
	if (!await pickVariantIfNeeded(editor.document.uri, compilationService)) {
		return;
	}
	const variant = compilationService.getSelectedVariant(editor.document.uri);
	if (!variant) {
		await window.showErrorMessage('No compilation variant is available for this file.');
		return;
	}
	const backend = compilationService.toolchainRegistry
		.getToolchainById(variant.toolchainProfileId);
	if (!backend) {
		await window.showErrorMessage(`Toolchain profile not found: ${variant.toolchainProfileId}`);
		return;
	}

	let kind = requestedKind;
	if (!kind) {
		const choice = await window.showQuickPick(
			supportedArtifactKinds.map(artifactKind => {
				const availability = compilationService.toolchainRegistry
					.getArtifactAvailability(variant.toolchainProfileId, artifactKind);
				return {
					label: artifactDefinitions[artifactKind].label,
					description: availability.status === 'available'
						? undefined
						: availability.status,
					detail: availability.status === 'available'
						? undefined
						: availability.explanation,
					artifactKind,
					availability,
				};
			}),
			{ title: 'Open Artifact', matchOnDescription: true, matchOnDetail: true },
		);
		if (!choice) {
			return;
		}
		if (choice.availability.status !== 'available') {
			await window.showInformationMessage(choice.availability.explanation);
			return;
		}
		kind = choice.artifactKind;
	}

	const availability = compilationService.toolchainRegistry
		.getArtifactAvailability(variant.toolchainProfileId, kind);
	if (availability.status !== 'available') {
		await window.showInformationMessage(availability.explanation);
		return;
	}

	const artifactUri = getArtifactUri(editor.document.uri, variant, kind, 'default');
	artifactProvider.requestRefresh(artifactUri);
	const options: TextDocumentShowOptions = {
		viewColumn: ViewColumn.Beside,
		preserveFocus: true,
		preview: false,
	};
	await window.showTextDocument(artifactUri, options);
}

function isSupportedSourceDocument(document: vscode.TextDocument): boolean {
	return document.uri.scheme === 'file'
		&& supportedLanguageIdentifiers.has(document.languageId);
}

async function pickVariantIfNeeded(source: vscode.Uri, service: CompilationService): Promise<boolean> {
	const variants = service.getVariants(source);
	if (variants.length <= 1) {
		return variants.length === 1;
	}

	return service.hasExplicitVariantSelection(source) || pickVariant(source, service);
}

async function pickVariant(source: vscode.Uri, service: CompilationService): Promise<boolean> {
	const variants = service.getVariants(source);
	if (variants.length === 0) {
		await window.showErrorMessage('No compilation variant is available for this file.');
		return false;
	}

	const selected = service.getSelectedVariant(source);
	const choice = await window.showQuickPick(
		variants.map(variant => ({
			label: variant.displayLabel,
			description: variant.id === selected?.id ? 'current' : variant.provider,
			detail: [variant.project, variant.target, variant.configuration].filter(Boolean).join(' · '),
			variant,
		})),
		{ title: 'Select compilation variant', matchOnDescription: true, matchOnDetail: true },
	);

	return choice ? service.selectVariant(source, choice.variant.id) : false;
}
