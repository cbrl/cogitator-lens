import path from 'path';
import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import type { CompilationService } from '../compilation/index.js';
import type { ConfigurationService } from '../services/configuration-service.js';
import { supportedLanguageIdentifiers } from '../toolchains/toolchain-map.js';
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
				await configuration.updateManualCompilationVariants(
					configuration.getManualCompilationVariants().filter((variant) => variant.id !== node.variant?.id),
				);
			}
		}),
		vscode.commands.registerTextEditorCommand('coglens.PickCompilationVariant', async (editor) => {
			if (!isSupportedSourceDocument(editor.document)) {
				return;
			}
			await pickVariant(editor.document.uri, compilationService);
		}),
	);
}

export async function pickVariantIfNeeded(source: vscode.Uri, service: CompilationService): Promise<boolean> {
	const variants = service.getVariants(source);
	if (variants.length <= 1) {
		return variants.length === 1;
	}
	return service.hasExplicitVariantSelection(source) || pickVariant(source, service);
}

export async function pickVariant(source: vscode.Uri, service: CompilationService): Promise<boolean> {
	const variants = service.getVariants(source);
	if (variants.length === 0) {
		await vscode.window.showErrorMessage('No compilation variant is available for this file.');
		return false;
	}
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
		project: existing?.project,
		target: existing?.target,
		configuration: existing?.configuration,
	};
	const variants = configuration.getManualCompilationVariants();
	const index = variants.findIndex((variant) => variant.id === setting.id);
	if (index >= 0) {
		variants[index] = setting;
	} else {
		variants.push(setting);
	}
	await configuration.updateManualCompilationVariants(variants);
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
