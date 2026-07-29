import vscode, {
	commands,
	ExtensionContext,
	TextDocumentShowOptions,
	ViewColumn,
	window,
	workspace,
} from 'vscode';
import { AsmDefinitionProvider } from './asm-document/asm-definition-provider.js';
import { AsmProvider, getAsmUri } from './asm-document/asm-provider.js';
import { CmakeVariantProvider } from './buildsystems/cmake.js';
import { CompilationDatabaseVariantProvider } from './buildsystems/compilation-database.js';
import { CompilationService } from './compilation/index.js';
import { ConfigurationService } from './services/configuration-service.js';
import type { IVariantProvider } from './interfaces/index.js';
import * as setup from './setup.js';
import * as logger from './logger.js';

const supportedLanguageIds = new Set(['c', 'cpp', 'objective-c', 'objective-cpp', 'cuda']);

export async function activate(context: ExtensionContext): Promise<void> {
	await warnAboutRemovedCompilerSetting(context);
	const configuration = new ConfigurationService();
	const compilationService = new CompilationService(configuration, context.workspaceState);
	const assemblyProvider = new AsmProvider(compilationService, configuration);
	const definitionProvider = new AsmDefinitionProvider(uri => assemblyProvider.getCompiledAssembly(uri));

	setup.createToolchainTreeView(context, compilationService.toolchainRegistry);
	setup.createCompilationInfoTreeView(context, compilationService);
	setup.createGlobalOptionsTreeView(context, compilationService);
	setup.setupCommands(
		context,
		compilationService,
		configuration,
	);

	const variantProviders: IVariantProvider[] = [
		new CmakeVariantProvider(),
		new CompilationDatabaseVariantProvider(),
	];
	const providerSubscriptions = variantProviders.map(provider =>
		provider.onSnapshot(snapshot => compilationService.reconcileProviderSnapshot(snapshot)));

	const contentProvider = workspace.registerTextDocumentContentProvider(AsmProvider.scheme, assemblyProvider);
	const definitionRegistration = vscode.languages.registerDefinitionProvider(
		{ scheme: AsmProvider.scheme },
		definitionProvider,
	);

	const disassemble = commands.registerTextEditorCommand('coglens.Disassemble', async editor => {
		if (!isSupportedSourceDocument(editor.document)) {
			await window.showWarningMessage('Cogitator Lens supports saved, file-backed C and C++ source files.');
			return;
		}
		const dirtyDecision = await resolveDirtyDocument(editor.document);
		if (dirtyDecision === 'cancel') {
			return;
		}
		if (dirtyDecision === 'saved-version') {
			assemblyProvider.allowDirtySavedCompilation(editor.document.uri);
		}
		if (!await pickVariantIfNeeded(editor.document.uri, compilationService)) {
			return;
		}
		const variant = compilationService.getSelectedVariant(editor.document.uri);
		if (!variant) {
			await window.showErrorMessage('No compilation variant is available for this file.');
			return;
		}

		const assemblyUri = getAsmUri(editor.document.uri, variant);
		assemblyProvider.requestRefresh(assemblyUri);
		const options: TextDocumentShowOptions = {
			viewColumn: ViewColumn.Beside,
			preserveFocus: true,
			preview: false,
		};
		await window.showTextDocument(assemblyUri, options);
	});

	const pickVariantCommand = commands.registerTextEditorCommand('coglens.PickCompilationVariant', async editor => {
		if (!isSupportedSourceDocument(editor.document)) {
			return;
		}
		if (await pickVariant(editor.document.uri, compilationService)) {
			const variant = compilationService.getSelectedVariant(editor.document.uri);
			if (variant) {
				assemblyProvider.requestRefresh(getAsmUri(editor.document.uri, variant));
			}
		}
	});

	context.subscriptions.push(
		configuration,
		compilationService,
		assemblyProvider,
		...variantProviders,
		...providerSubscriptions,
		contentProvider,
		definitionRegistration,
		disassemble,
		pickVariantCommand,
	);

	await Promise.all(variantProviders.map(provider => provider.initialize()));
}

async function warnAboutRemovedCompilerSetting(context: ExtensionContext): Promise<void> {
	const scopes = [
		workspace.getConfiguration('coglens'),
		...(workspace.workspaceFolders ?? []).map(folder =>
			workspace.getConfiguration('coglens', folder.uri)
		),
	];
	const configured = scopes.some(configuration => {
		const inspection = configuration.inspect<unknown>('compilers');
		return inspection !== undefined && [
			inspection.globalValue,
			inspection.workspaceValue,
			inspection.workspaceFolderValue,
			inspection.globalLanguageValue,
			inspection.workspaceLanguageValue,
			inspection.workspaceFolderLanguageValue,
		].some(value => value !== undefined);
	});
	if (!configured) {
		return;
	}
	logger.logChannel.warn('The removed coglens.compilers setting is present; use coglens.toolchains instead.');
	const noticeKey = 'coglens.migration.compilers-to-toolchains';
	if (!context.globalState.get<boolean>(noticeKey)) {
		await window.showWarningMessage(
			'Cogitator Lens renamed “coglens.compilers” to “coglens.toolchains”. Update your settings to keep those profiles active.',
		);
		await context.globalState.update(noticeKey, true);
	}
}

function isSupportedSourceDocument(document: vscode.TextDocument): boolean {
	return document.uri.scheme === 'file' && supportedLanguageIds.has(document.languageId);
}

type DirtyDocumentDecision = 'current' | 'saved-version' | 'cancel';

async function resolveDirtyDocument(document: vscode.TextDocument): Promise<DirtyDocumentDecision> {
	if (!document.isDirty) {
		return 'current';
	}
	const choice = await window.showWarningMessage(
		'This source file has unsaved changes. What should Cogitator Lens compile?',
		{ modal: true },
		'Save and Compile',
		'Compile Saved Version',
		'Cancel',
	);
	if (choice === 'Save and Compile') {
		return await document.save() ? 'current' : 'cancel';
	}
	return choice === 'Compile Saved Version' ? 'saved-version' : 'cancel';
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
