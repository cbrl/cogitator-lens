import path from 'path';
import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import type { CompilationService } from '../compilation/index.js';
import type { ConfigurationService } from '../services/configuration-service.js';
import { getToolchainDefinition, supportedLanguageIdentifiers } from '../toolchains/toolchain-map.js';
import type { CompilationVariant, ManualCompilationVariantSettings, ToolchainProfile } from '../types/index.js';
import type { CompilationInfoTreeNode } from '../tree/compilation-info-tree.js';
import { inputStringArray, inputStringRecord, pickFrom } from '../ui/quick-input.js';

export interface VariantCommandDependencies {
	readonly compilationService: CompilationService;
	readonly configuration: ConfigurationService;
}

export function register(context: vscode.ExtensionContext, deps: VariantCommandDependencies): void {
	const { compilationService, configuration } = deps;
	context.subscriptions.push(
		vscode.commands.registerCommand('coglens.AddCompilationVariant', async (node?: CompilationInfoTreeNode) =>
			configureManualVariant(node?.source ?? activeFileUri(), undefined, compilationService, configuration),
		),
		vscode.commands.registerCommand('coglens.EditCompilationVariant', async (node?: CompilationInfoTreeNode) => {
			if (node?.variant) {
				await configureManualVariant(node.variant.source, node.variant, compilationService, configuration);
			}
		}),
		vscode.commands.registerCommand('coglens.DeleteCompilationVariant', async (node?: CompilationInfoTreeNode) => {
			if (node?.variant?.provider !== 'manual') {
				return;
			}
			const confirmation = await vscode.window.showWarningMessage(
				`Delete the workspace variant "${node.variant.displayLabel}"?`,
				{ modal: true },
				'Delete',
			);
			if (confirmation === 'Delete') {
				await configuration.removeManualCompilationVariant(node.variant.id);
			}
		}),
		vscode.commands.registerTextEditorCommand('coglens.PickCompilationVariant', async (editor) => {
			if (!isSupportedSourceDocument(editor.document)) {
				return;
			}
			await waitForProviders(compilationService);
			if (compilationService.getVariants(editor.document.uri).length === 0) {
				await explainMissingVariant(editor.document, deps);
				return;
			}
			await pickVariant(editor.document.uri, compilationService);
		}),
	);
}

/**
 * Returns the variant that produces artifacts for a source document. It waits for the first provider
 * results, asks for a choice when several discovered variants describe the source, and explains what
 * to configure when none does.
 */
export async function resolveSourceVariant(
	document: vscode.TextDocument,
	deps: VariantCommandDependencies,
): Promise<CompilationVariant | undefined> {
	const { compilationService } = deps;
	await waitForProviders(compilationService);
	if (compilationService.getVariants(document.uri).length === 0) {
		await explainMissingVariant(document, deps);
		return undefined;
	}
	if (compilationService.needsVariantChoice(document.uri) && !(await pickVariant(document.uri, compilationService))) {
		return undefined;
	}
	return compilationService.getSelectedVariant(document.uri);
}

async function waitForProviders(service: CompilationService): Promise<void> {
	if (!service.providersAreReady) {
		await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Window, title: 'Discovering compilation variants' },
			() => service.whenProvidersReady(),
		);
	}
}

async function explainMissingVariant(document: vscode.TextDocument, deps: VariantCommandDependencies): Promise<void> {
	const { compilationService, configuration } = deps;
	const name = path.basename(document.uri.fsPath);
	// Project toolchains (CMake, compilation databases, Python environments) only compile their own files.
	const projectToolchainExists = compilationService.toolchainRegistry
		.getProfiles()
		.some((profile) => getToolchainDefinition(profile.kind).languageIdentifiers.includes(document.languageId));
	if (projectToolchainExists) {
		const choice = await vscode.window.showWarningMessage(
			`${name} is not part of a discovered project. Add a variant to choose its toolchain and arguments.`,
			'Add Variant…',
			'Add Toolchain…',
		);
		if (choice === 'Add Variant…') {
			await configureManualVariant(document.uri, undefined, compilationService, configuration);
		} else if (choice === 'Add Toolchain…') {
			await vscode.commands.executeCommand('coglens.AddToolchain');
		}
		return;
	}
	const detectionEnabled = configuration.getDetectToolchainsOnPath();
	const choice = await vscode.window.showWarningMessage(
		detectionEnabled
			? `No toolchain that compiles ${name} was found on PATH or in settings.`
			: `No toolchain that compiles ${name} is configured, and detection on PATH is turned off.`,
		'Add Toolchain…',
		detectionEnabled ? 'Detect Again' : 'Turn On Detection',
	);
	if (choice === 'Add Toolchain…') {
		await vscode.commands.executeCommand('coglens.AddToolchain');
	} else if (choice === 'Detect Again') {
		await vscode.commands.executeCommand('coglens.DetectToolchains');
	} else if (choice === 'Turn On Detection') {
		await vscode.commands.executeCommand('workbench.action.openSettings', 'coglens.detectToolchainsOnPath');
	}
}

export async function pickVariant(source: vscode.Uri, service: CompilationService): Promise<boolean> {
	const variants = service.getVariants(source);
	const selected = service.getSelectedVariant(source);
	const choice = await pickFrom(
		variants,
		(variant) => ({
			label: variant.displayLabel,
			description: variant.id === selected?.id ? 'current' : variant.provider,
			detail: [variant.project, variant.target, variant.configuration].filter(Boolean).join(' · '),
		}),
		{ title: 'Select compilation variant', matchOnDescription: true, matchOnDetail: true },
	);
	return choice ? service.selectVariant(source, choice.id) : false;
}

async function configureManualVariant(
	initialSource: vscode.Uri | undefined,
	existing: CompilationVariant | undefined,
	compilationService: CompilationService,
	configuration: ConfigurationService,
): Promise<void> {
	const source = initialSource ?? (await pickSourceFile());
	if (!source) {
		return;
	}
	const profiles = [...compilationService.toolchainRegistry.getProfiles()].sort((left, right) =>
		left.displayName.localeCompare(right.displayName),
	);
	if (!profiles.length) {
		await vscode.window.showWarningMessage('Add or discover a toolchain before creating a compilation variant.');
		return;
	}
	const displayLabel = (
		await vscode.window.showInputBox({
			title:
				existing?.provider === 'manual'
					? 'Edit Workspace Compilation Variant'
					: existing
						? 'Create Workspace Variant from Discovered Variant'
						: 'Add Workspace Compilation Variant',
			prompt: 'Variant name',
			value: existing?.displayLabel ?? 'Workspace',
			validateInput: (value) => (value.trim() ? undefined : 'A name is required'),
		})
	)?.trim();
	if (!displayLabel) {
		return;
	}
	const profile = await pickToolchainProfile(profiles, existing?.toolchainProfileId);
	if (!profile) {
		return;
	}
	const workingDirectory = (
		await vscode.window.showInputBox({
			title: 'Working Directory',
			value:
				existing?.workingDirectory ??
				vscode.workspace.getWorkspaceFolder(source)?.uri.fsPath ??
				path.dirname(source.fsPath),
			validateInput: (value) => (value.trim() ? undefined : 'A working directory is required'),
		})
	)?.trim();
	if (!workingDirectory) {
		return;
	}
	const args = await inputStringArray('Compiler Arguments', existing?.arguments ?? []);
	if (!args) {
		return;
	}
	const environment = await inputStringRecord('Environment Variables', existing?.environment ?? {});
	if (!environment) {
		return;
	}
	const setting: ManualCompilationVariantSettings = {
		id: existing?.provider === 'manual' ? existing.id : `manual:${randomUUID()}`,
		source: source.fsPath,
		displayLabel,
		toolchainProfileId: profile.id,
		workingDirectory,
		arguments: args,
		environment,
		...(existing?.project ? { project: existing.project } : {}),
		...(existing?.target ? { target: existing.target } : {}),
		...(existing?.configuration ? { configuration: existing.configuration } : {}),
	};
	await configuration.upsertManualCompilationVariant(setting);
	await compilationService.selectVariant(source, setting.id);
}

async function pickToolchainProfile(
	profiles: readonly ToolchainProfile[],
	selectedId: string | undefined,
): Promise<ToolchainProfile | undefined> {
	const selected = profiles.find((profile) => profile.id === selectedId);
	return pickFrom(
		profiles,
		(profile) => ({
			label: profile.displayName,
			description: profile.kind,
			detail: profile.executable,
		}),
		{
			title: 'Toolchain',
			placeHolder: selected ? `Current: ${selected.displayName}` : 'Select the toolchain for this variant',
			matchOnDescription: true,
			matchOnDetail: true,
		},
	);
}

async function pickSourceFile(): Promise<vscode.Uri | undefined> {
	const selection = await vscode.window.showOpenDialog({
		title: 'Select Source File',
		canSelectMany: false,
		canSelectFiles: true,
		canSelectFolders: false,
	});
	return selection?.[0];
}

/** Returns the active editor's file URI, or nothing for a non-file editor. */
export function activeFileUri(): vscode.Uri | undefined {
	const uri = vscode.window.activeTextEditor?.document.uri;
	return uri?.scheme === 'file' ? uri : undefined;
}

export function isSupportedSourceDocument(document: vscode.TextDocument): boolean {
	return document.uri.scheme === 'file' && supportedLanguageIdentifiers.has(document.languageId);
}
