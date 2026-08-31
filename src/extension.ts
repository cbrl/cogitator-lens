import vscode, {
	commands,
	ExtensionContext,
	TextDocumentShowOptions,
	ViewColumn,
	window,
	workspace,
} from 'vscode';
import { ArtifactNavigationProvider } from './artifact-document/artifact-navigation-provider.js';
import {
	ArtifactSemanticTokensProvider,
	artifactSemanticTokensLegend,
} from './artifact-document/artifact-semantic-tokens-provider.js';
import { ArtifactDocumentProvider, getArtifactUri } from './artifact-document/artifact-document-provider.js';
import { ArtifactDocumentRegistry } from './artifact-document/artifact-document-registry.js';
import { CmakeVariantProvider } from './buildsystems/cmake.js';
import { CompilationDatabaseVariantProvider } from './buildsystems/compilation-database.js';
import { PythonEnvironmentVariantProvider } from './buildsystems/python-environments.js';
import { VariantProvider } from './buildsystems/variant-provider.js';
import { CompilationService } from './compilation/index.js';
import { ConfigurationService } from './services/configuration-service.js';
import type { ArtifactKind } from './types/index.js';
import {
	artifactDefinitions,
	supportedArtifactKinds,
} from './artifacts/core/artifact-definitions.js';
import {
	effectiveArtifactPresets,
	type ArtifactPreset,
} from './artifacts/ui/presets.js';
import {
	artifactPickerIcon,
	partitionArtifactPickerChoices,
	type ArtifactPickerChoice,
} from './artifacts/ui/artifact-picker.js';
import {
	getArtifactOutputChoices,
	supportedLanguageIdentifiers,
} from './toolchains/toolchain-map.js';
import * as setup from './setup.js';
import { GraphPanelManager } from './webview/graph-panel-manager.js';

export async function activate(context: ExtensionContext): Promise<void> {
	const configuration = new ConfigurationService();
	const compilationService = new CompilationService(
		configuration,
		context.workspaceState,
	);
	const artifactRegistry = new ArtifactDocumentRegistry(compilationService, configuration);
	const artifactProvider = new ArtifactDocumentProvider(compilationService, configuration, artifactRegistry);
	const graphPanels = new GraphPanelManager(context, artifactRegistry);
	const navigationProvider = new ArtifactNavigationProvider(uri =>
		artifactProvider.getRenderedArtifact(uri));

	setup.createToolchainTreeView(context, compilationService.toolchainRegistry);
	setup.createCompilationInfoTreeView(context, compilationService);
	setup.createGlobalOptionsTreeView(context, compilationService);
	setup.createArtifactPresetsTreeView(context, configuration);
	setup.createArtifactDetailsTreeView(context, artifactProvider, graphPanels);
	setup.setupCommands(context, compilationService, configuration, artifactProvider);

	const variantProviders: VariantProvider[] = [
		new CmakeVariantProvider(),
		new CompilationDatabaseVariantProvider(configuration),
		new PythonEnvironmentVariantProvider(),
	];
	const providerSubscriptions = variantProviders.map(provider =>
		provider.onSnapshot(snapshot => compilationService.reconcileProviderSnapshot(snapshot)));

	const contentProvider = workspace.registerTextDocumentContentProvider(
		ArtifactDocumentProvider.scheme,
		artifactProvider,
	);
	const definitionRegistration = vscode.languages.registerDefinitionProvider(
		{ scheme: ArtifactDocumentProvider.scheme },
		navigationProvider,
	);
	const linkRegistration = vscode.languages.registerDocumentLinkProvider(
		{ scheme: ArtifactDocumentProvider.scheme },
		navigationProvider,
	);
	const foldingRegistration = vscode.languages.registerFoldingRangeProvider(
		{ scheme: ArtifactDocumentProvider.scheme },
		navigationProvider,
	);
	const hoverRegistration = vscode.languages.registerHoverProvider(
		{ scheme: ArtifactDocumentProvider.scheme },
		navigationProvider,
	);
	const symbolRegistration = vscode.languages.registerDocumentSymbolProvider(
		{ scheme: ArtifactDocumentProvider.scheme },
		navigationProvider,
	);
	const semanticTokensRegistration = vscode.languages.registerDocumentSemanticTokensProvider(
		{ scheme: ArtifactDocumentProvider.scheme },
		new ArtifactSemanticTokensProvider(uri => artifactProvider.getRenderedArtifact(uri)),
		artifactSemanticTokensLegend,
	);

	const openArtifactCommand = commands.registerTextEditorCommand(
		'coglens.OpenArtifact',
		editor => openArtifact(
			editor,
			undefined,
			compilationService,
			artifactProvider,
			graphPanels,
			configuration,
		),
	);
	const openControlFlowGraphCommand = commands.registerTextEditorCommand(
		'coglens.OpenControlFlowGraph',
		editor => openArtifact(
			editor,
			'control-flow-graph',
			compilationService,
			artifactProvider,
			graphPanels,
			configuration,
		),
	);
	const compareArtifactsCommand = commands.registerTextEditorCommand(
		'coglens.CompareArtifacts',
		editor => compareArtifacts(editor, compilationService, configuration),
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

	const updateEditorContexts = (): Thenable<unknown[]> => Promise.all([
		commands.executeCommand(
			'setContext',
			'coglens.supportedSource',
			Boolean(window.activeTextEditor
				&& isSupportedSourceDocument(window.activeTextEditor.document)),
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
		openArtifactCommand,
		openControlFlowGraphCommand,
		compareArtifactsCommand,
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
	artifactProvider: ArtifactDocumentProvider,
	graphPanels: GraphPanelManager,
	configuration: ConfigurationService,
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
	const backend = compilationService.toolchainRegistry.getToolchainById(variant.toolchainProfileId);
	if (!backend) {
		await window.showErrorMessage(`Toolchain profile not found: ${variant.toolchainProfileId}`);
		return;
	}

	let kind = requestedKind;
	if (!kind) {
		const sections = partitionArtifactPickerChoices(
			supportedArtifactKinds.map(artifactKind => ({
				label: artifactDefinitions[artifactKind].label,
				iconPath: new vscode.ThemeIcon(artifactPickerIcon(artifactKind)),
				artifactKind,
				availability: compilationService.toolchainRegistry
					.getArtifactAvailability(variant.toolchainProfileId, artifactKind),
			})),
		);
		const items: Array<vscode.QuickPickItem | ArtifactQuickPickChoice> = [];
		if (sections.unavailable.length > 0) {
			items.push(
				{ label: 'Available', kind: vscode.QuickPickItemKind.Separator },
				...sections.available.map(availableArtifactPickerItem),
				{ label: 'Unavailable', kind: vscode.QuickPickItemKind.Separator },
				...sections.unavailable.map(unavailableArtifactPickerItem),
			);
		} else {
			items.push(...sections.available.map(availableArtifactPickerItem));
		}
		const choice = await window.showQuickPick(
			items,
			{ title: 'Open Artifact', matchOnDescription: true, matchOnDetail: true },
		);
		if (!choice || !('artifactKind' in choice)) {
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
	const outputChoices = getArtifactOutputChoices(backend.profile, kind);
	let artifactOutput: (typeof outputChoices)[number] | undefined;
	if (outputChoices.length === 1) {
		artifactOutput = outputChoices[0];
	} else if (outputChoices.length > 1) {
		artifactOutput = await window.showQuickPick(
			outputChoices.map(output => ({
				label: output.label,
				detail: output.description,
				output,
			})),
			{ title: `${artifactDefinitions[kind].label} output` },
		).then(choice => choice?.output);
	}
	if (outputChoices.length > 0 && !artifactOutput) {
		return;
	}

	const presets = [...effectiveArtifactPresets(
		configuration.getArtifactPresets(editor.document.uri),
		kind,
	).values()];
	const preset = presets.length === 1
		? presets[0]
		: await window.showQuickPick(
			presets.map(candidate => ({
				label: candidate.id === 'default' ? 'Default' : candidate.id,
				description: candidate.extraArguments.join(' '),
				preset: candidate,
			})),
			{ title: `${artifactDefinitions[kind].label} preset` },
		).then(choice => choice?.preset);
	if (!preset) {
		return;
	}

	const artifactUri = getArtifactUri(
		editor.document.uri,
		variant,
		kind,
		preset.id,
		artifactOutput?.id,
	);
	if (artifactDefinitions[kind].presentation === 'graph') {
		await graphPanels.open(artifactUri);
		return;
	}
	artifactProvider.requestRefresh(artifactUri);
	const options: TextDocumentShowOptions = {
		viewColumn: ViewColumn.Beside,
		preserveFocus: true,
		preview: false,
	};
	await window.showTextDocument(artifactUri, options);
}

type ArtifactQuickPickChoice =
	vscode.QuickPickItem
	& Omit<ArtifactPickerChoice, 'label'>;

function availableArtifactPickerItem(choice: ArtifactPickerChoice): ArtifactQuickPickChoice {
	return { ...choice };
}

function unavailableArtifactPickerItem(choice: ArtifactPickerChoice): ArtifactQuickPickChoice {
	return {
		...choice,
		label: `$(circle-slash) ${choice.label}`,
		description: 'Unavailable',
		detail: choice.availability.status === 'unavailable'
			? choice.availability.explanation
			: undefined,
	};
}

interface ComparisonTarget {
	readonly id: string;
	readonly label: string;
	readonly description: string;
	readonly variant: import('./types/index.js').CompilationVariant;
	readonly preset?: ArtifactPreset;
}

async function compareArtifacts(
	editor: vscode.TextEditor,
	compilationService: CompilationService,
	configuration: ConfigurationService,
): Promise<void> {
	if (!isSupportedSourceDocument(editor.document)) {
		await window.showWarningMessage(
			'Cogitator Lens compares saved, file-backed sources declared by its toolchains.',
		);
		return;
	}
	if (!await pickVariantIfNeeded(editor.document.uri, compilationService)) {
		return;
	}
	const variants = compilationService.getVariants(editor.document.uri);
	const selectedVariant = compilationService.getSelectedVariant(editor.document.uri);
	if (!selectedVariant) {
		await window.showErrorMessage('No compilation variant is available for this file.');
		return;
	}
	const targets: ComparisonTarget[] = [
		...variants.map(variant => ({
			id: `variant:${variant.id}`,
			label: variant.displayLabel,
			description: 'Compilation variant',
			variant,
		})),
		...configuration.getArtifactPresets(editor.document.uri).map(preset => ({
			id: `preset:${preset.id}`,
			label: preset.id,
			description: `${artifactDefinitions[preset.artifactKind].label} preset`,
			variant: selectedVariant,
			preset,
		})),
	];
	if (targets.length < 2) {
		await window.showInformationMessage(
			'Artifact comparison needs at least two variants or configured presets.',
		);
		return;
	}

	const left = await pickComparisonTarget(targets, 'Select the left artifact');
	if (!left) {
		return;
	}
	const right = await pickComparisonTarget(
		targets.filter(target => target.id !== left.id),
		'Select the right artifact',
	);
	if (!right) {
		return;
	}
	if (
		(left.preset && artifactDefinitions[left.preset.artifactKind].presentation === 'graph')
		|| (right.preset && artifactDefinitions[right.preset.artifactKind].presentation === 'graph')
	) {
		await window.showInformationMessage(
			'Control-flow graphs cannot be compared in the native text diff. Open each graph separately.',
		);
		return;
	}

	const allCommonKinds = supportedArtifactKinds.filter(kind =>
		targetSupportsKind(left, kind, compilationService)
		&& targetSupportsKind(right, kind, compilationService));
	const commonKinds = allCommonKinds.filter(kind =>
		artifactDefinitions[kind].presentation === 'text');
	if (commonKinds.length === 0) {
		await window.showWarningMessage(allCommonKinds.some(kind =>
			artifactDefinitions[kind].presentation === 'graph')
			? 'Control-flow graphs cannot be compared in the native text diff. Open each graph separately.'
			: `"${left.label}" and "${right.label}" do not support a common artifact kind.`);
		return;
	}
	const kind = commonKinds.length === 1
		? commonKinds[0]
		: await window.showQuickPick(
			commonKinds.map(artifactKind => ({
				label: artifactDefinitions[artifactKind].label,
				artifactKind,
			})),
			{ title: 'Select the artifact kind to compare' },
		).then(choice => choice?.artifactKind);
	if (!kind) {
		return;
	}

	const leftUri = comparisonUri(editor.document.uri, left, kind);
	const rightUri = comparisonUri(editor.document.uri, right, kind);
	if (leftUri.toString() === rightUri.toString()) {
		await window.showInformationMessage(
			'These selections resolve to the same artifact. Choose a different variant or preset.',
		);
		return;
	}
	await commands.executeCommand(
		'vscode.diff',
		leftUri,
		rightUri,
		`${left.label} ↔ ${right.label} — ${artifactDefinitions[kind].label}`,
		{ preview: false },
	);
}

async function pickComparisonTarget(
	targets: readonly ComparisonTarget[],
	title: string,
): Promise<ComparisonTarget | undefined> {
	return window.showQuickPick(
		targets.map(target => ({
			label: target.label,
			description: target.description,
			target,
		})),
		{ title, matchOnDescription: true },
	).then(choice => choice?.target);
}

function targetSupportsKind(
	target: ComparisonTarget,
	kind: ArtifactKind,
	compilationService: CompilationService,
): boolean {
	return (!target.preset || target.preset.artifactKind === kind)
		&& compilationService.toolchainRegistry
			.getArtifactAvailability(target.variant.toolchainProfileId, kind).status === 'available';
}

function comparisonUri(
	source: vscode.Uri,
	target: ComparisonTarget,
	kind: ArtifactKind,
): vscode.Uri {
	return getArtifactUri(
		source,
		target.variant,
		kind,
		target.preset?.id ?? 'default',
	);
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
