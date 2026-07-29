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
import { CmakeMonitor } from './buildsystems/cmake.js';
import { CompilationDatabaseMonitor } from './buildsystems/compilation-database.js';
import { CompilationService } from './compilation/index.js';
import { ConfigurationService } from './services/configuration-service.js';
import type { IBuildSystemMonitor } from './interfaces/index.js';
import * as setup from './setup.js';

const supportedLanguageIds = new Set(['c', 'cpp', 'objective-c', 'objective-cpp', 'cuda']);

export async function activate(context: ExtensionContext): Promise<void> {
	const configuration = new ConfigurationService();
	const compilationService = new CompilationService(configuration, context.workspaceState);
	const assemblyProvider = new AsmProvider(compilationService, configuration);
	const definitionProvider = new AsmDefinitionProvider(uri => assemblyProvider.getCompiledAssembly(uri));

	setup.createCompilerTreeView(context, compilationService.compilerRegistry);
	setup.createCompilationInfoTreeView(context, compilationService);
	setup.createGlobalOptionsTreeView(context, compilationService);
	setup.setupCommands(
		context,
		compilationService,
		configuration,
	);

	const buildsystemMonitors: IBuildSystemMonitor[] = [
		new CmakeMonitor(),
		new CompilationDatabaseMonitor(),
	];
	const monitorSubscriptions = buildsystemMonitors.map(monitor =>
		monitor.onSnapshot(snapshot => compilationService.reconcileProviderSnapshot(snapshot)));

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
		...buildsystemMonitors,
		...monitorSubscriptions,
		contentProvider,
		definitionRegistration,
		disassemble,
		pickVariantCommand,
	);

	await Promise.all(buildsystemMonitors.map(monitor => monitor.initialize()));
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
