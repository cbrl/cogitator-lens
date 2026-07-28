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
import { CompilationService } from './compilation/index.js';
import { ConfigurationService } from './services/configuration-service.js';
import * as setup from './setup.js';

const supportedLanguageIds = new Set(['c', 'cpp', 'objective-c', 'objective-cpp', 'cuda']);

export async function activate(context: ExtensionContext): Promise<void> {
	const configuration = new ConfigurationService();
	const compilationService = new CompilationService(configuration, context.workspaceState);
	const assemblyProvider = new AsmProvider(compilationService);
	const definitionProvider = new AsmDefinitionProvider(uri => assemblyProvider.getCompiledAssembly(uri));

	const compilerTree = setup.createCompilerTreeView(context, compilationService.compilerRegistry);
	const compilationTree = setup.createCompilationInfoTreeView(context, compilationService);
	const filterTree = setup.createGlobalOptionsTreeView(context, compilationService);
	setup.setupCommands(
		context,
		compilationService,
		configuration,
		compilerTree,
		compilationTree,
		filterTree,
	);

	const cmakeMonitor = new CmakeMonitor();
	const cmakeSubscription = cmakeMonitor.onSnapshot(snapshot =>
		compilationService.reconcileProviderSnapshot(snapshot));

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

		const assemblyUri = getAsmUri(editor.document.uri);
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
		await pickVariant(editor.document.uri, compilationService);
		const assemblyUri = getAsmUri(editor.document.uri);
		assemblyProvider.requestRefresh(assemblyUri);
	});

	context.subscriptions.push(
		configuration,
		compilationService,
		assemblyProvider,
		cmakeMonitor,
		cmakeSubscription,
		contentProvider,
		definitionRegistration,
		disassemble,
		pickVariantCommand,
	);

	await cmakeMonitor.initialize();
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
