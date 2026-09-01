import path from 'path';
import * as vscode from 'vscode';
import { getArtifactUri, type ArtifactDocumentProvider } from '../artifact-document/artifact-document-provider.js';
import { artifactDefinitions, supportedArtifactKinds } from '../artifacts/core/artifact-definitions.js';
import {
	needsArtifactOutputPicker,
	partitionArtifactPickerChoices,
	type ArtifactPickerChoice,
} from '../artifacts/ui/artifact-picker.js';
import { effectiveArtifactPresets, type ArtifactPreset } from '../artifacts/ui/presets.js';
import type { CompilationService } from '../compilation/index.js';
import * as logger from '../logger.js';
import type { ConfigurationService } from '../services/configuration-service.js';
import { getArtifactOutputChoices, supportedLanguageIdentifiers } from '../toolchains/toolchain-map.js';
import type { TreeNode } from '../tree/treedata.js';
import type { ArtifactKind, CompilationVariant } from '../types/index.js';
import { pickFrom } from '../ui/quick-input.js';
import type { GraphPanelManager } from '../webview/graph-panel-manager.js';
import { pickVariantIfNeeded } from './variants.js';

export interface ArtifactCommandDependencies {
	readonly compilationService: CompilationService;
	readonly configuration: ConfigurationService;
	readonly artifacts: ArtifactDocumentProvider;
	readonly graphPanels: GraphPanelManager;
}

export function register(context: vscode.ExtensionContext, deps: ArtifactCommandDependencies): void {
	const { compilationService, configuration, artifacts, graphPanels } = deps;
	context.subscriptions.push(
		vscode.commands.registerTextEditorCommand('coglens.OpenArtifact', (editor) =>
			openArtifact(editor, undefined, deps),
		),
		vscode.commands.registerTextEditorCommand('coglens.OpenControlFlowGraph', (editor) =>
			openArtifact(editor, 'control-flow-graph', deps),
		),
		vscode.commands.registerTextEditorCommand('coglens.CompareArtifacts', (editor) =>
			compareArtifacts(editor, compilationService, configuration),
		),
		vscode.commands.registerCommand('coglens.CopyText', async (node?: TreeNode) => {
			const text = node?.copyText ?? node?.label;
			if (text !== undefined) {
				await vscode.env.clipboard.writeText(text);
			}
		}),
		vscode.commands.registerCommand('coglens.RefreshArtifact', async () => {
			if (!artifacts.refreshActiveArtifact()) {
				await vscode.window.showInformationMessage('Focus an open text artifact to refresh it.');
			}
		}),
		vscode.commands.registerCommand('coglens.CancelGeneration', async () => {
			if (!artifacts.cancelActiveArtifact()) {
				await vscode.window.showInformationMessage('The active artifact is not being generated.');
			}
		}),
		vscode.commands.registerCommand('coglens.ShowLog', () => logger.logChannel.show()),
		vscode.commands.registerCommand('coglens.RevealArtifactSource', async () => {
			const snapshot = artifacts.getActiveArtifactDocumentState();
			if (snapshot) {
				const activeEditor = vscode.window.activeTextEditor;
				const mappedSource = activeEditor
					? artifacts.getArtifactDocumentContent(activeEditor.document.uri)?.lines[
							activeEditor.selection.active.line
						]?.source
					: undefined;
				const hasMappedSource = Boolean(mappedSource?.file && mappedSource.line);
				const sourceUri = hasMappedSource
					? vscode.Uri.file(path.normalize(mappedSource!.file!))
					: vscode.Uri.parse(snapshot.identity.sourceUri);
				const position = hasMappedSource
					? new vscode.Position(mappedSource!.line! - 1, mappedSource!.column ?? 0)
					: undefined;
				await vscode.window.showTextDocument(sourceUri, {
					preview: false,
					selection: position ? new vscode.Range(position, position) : undefined,
				});
			}
		}),
		vscode.commands.registerCommand('coglens.ShowArtifactStatus', async () => showArtifactStatusActions(artifacts)),
		...[
			['coglens.OpenToolchainSettingsJson', 'coglens.toolchains'],
			['coglens.OpenCompileSettingsJson', 'coglens.compileVariants'],
			['coglens.OpenArtifactSettingsJson', 'coglens.artifactOptions'],
			['coglens.OpenPresetSettingsJson', 'coglens.artifactPresets'],
		].map(([command, key]) => vscode.commands.registerCommand(command, () => openWorkspaceSettingsJson(key))),
	);
}

async function openArtifact(
	editor: vscode.TextEditor,
	requestedKind: ArtifactKind | undefined,
	deps: ArtifactCommandDependencies,
): Promise<void> {
	const { compilationService, artifacts, graphPanels, configuration } = deps;
	if (!isSupportedSourceDocument(editor.document)) {
		await vscode.window.showWarningMessage(
			'Cogitator Lens supports saved, file-backed sources declared by its toolchains.',
		);
		return;
	}
	if (!(await pickVariantIfNeeded(editor.document.uri, compilationService))) {
		return;
	}
	const variant = compilationService.getSelectedVariant(editor.document.uri);
	if (!variant) {
		await vscode.window.showErrorMessage('No compilation variant is available for this file.');
		return;
	}
	const backend = compilationService.toolchainRegistry.getToolchainById(variant.toolchainProfileId);
	if (!backend) {
		await vscode.window.showErrorMessage(`Toolchain profile not found: ${variant.toolchainProfileId}`);
		return;
	}
	let kind = requestedKind;
	if (!kind) {
		const sections = partitionArtifactPickerChoices(
			supportedArtifactKinds.map((artifactKind) => ({
				label: artifactDefinitions[artifactKind].label,
				iconPath: new vscode.ThemeIcon(artifactDefinitions[artifactKind].icon),
				artifactKind,
				availability: compilationService.toolchainRegistry.getArtifactAvailability(
					variant.toolchainProfileId,
					artifactKind,
				),
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
		const choice = await vscode.window.showQuickPick(items, {
			title: 'Open Artifact',
			matchOnDescription: true,
			matchOnDetail: true,
		});
		if (!choice || !('artifactKind' in choice)) {
			return;
		}
		if (choice.availability.status !== 'available') {
			await vscode.window.showInformationMessage(choice.availability.explanation);
			return;
		}
		kind = choice.artifactKind;
	}
	const availability = compilationService.toolchainRegistry.getArtifactAvailability(variant.toolchainProfileId, kind);
	if (availability.status !== 'available') {
		await vscode.window.showInformationMessage(availability.explanation);
		return;
	}
	const outputChoices = getArtifactOutputChoices(backend.profile, kind);
	let artifactOutput = outputChoices.length === 1 ? outputChoices[0] : undefined;
	if (needsArtifactOutputPicker(outputChoices)) {
		artifactOutput = await pickFrom(
			outputChoices,
			(output) => ({
				label: output.label,
				detail: output.description,
			}),
			{ title: `${artifactDefinitions[kind].label} output` },
		);
	}
	if (outputChoices.length > 0 && !artifactOutput) {
		return;
	}
	const presets = [...effectiveArtifactPresets(configuration.getArtifactPresets(editor.document.uri), kind).values()];
	const preset =
		presets.length === 1
			? presets[0]
			: await pickFrom(
					presets,
					(candidate) => ({
						label: candidate.id === 'default' ? 'Default' : candidate.id,
						description: candidate.extraArguments.join(' '),
					}),
					{ title: `${artifactDefinitions[kind].label} preset` },
				);
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
	artifacts.requestRefresh(artifactUri);
	await vscode.window.showTextDocument(artifactUri, {
		viewColumn: vscode.ViewColumn.Beside,
		preserveFocus: true,
		preview: false,
	});
}

type ArtifactQuickPickChoice = vscode.QuickPickItem & Omit<ArtifactPickerChoice, 'label'>;

function availableArtifactPickerItem(choice: ArtifactPickerChoice): ArtifactQuickPickChoice {
	return { ...choice };
}

function unavailableArtifactPickerItem(choice: ArtifactPickerChoice): ArtifactQuickPickChoice {
	return {
		...choice,
		label: `$(circle-slash) ${choice.label}`,
		description: 'Unavailable',
		detail: choice.availability.status === 'unavailable' ? choice.availability.explanation : undefined,
	};
}

interface ComparisonTarget {
	readonly id: string;
	readonly label: string;
	readonly description: string;
	readonly variant: CompilationVariant;
	readonly preset?: ArtifactPreset;
}

const graphComparisonMessage =
	'Control-flow graphs cannot be compared in the native text diff. Open each graph separately.';

async function compareArtifacts(
	editor: vscode.TextEditor,
	compilationService: CompilationService,
	configuration: ConfigurationService,
): Promise<void> {
	if (!isSupportedSourceDocument(editor.document)) {
		await vscode.window.showWarningMessage(
			'Cogitator Lens compares saved, file-backed sources declared by its toolchains.',
		);
		return;
	}
	if (!(await pickVariantIfNeeded(editor.document.uri, compilationService))) {
		return;
	}
	const variants = compilationService.getVariants(editor.document.uri);
	const selectedVariant = compilationService.getSelectedVariant(editor.document.uri);
	if (!selectedVariant) {
		await vscode.window.showErrorMessage('No compilation variant is available for this file.');
		return;
	}
	const targets: ComparisonTarget[] = [
		...variants.map((variant) => ({
			id: `variant:${variant.id}`,
			label: variant.displayLabel,
			description: 'Compilation variant',
			variant,
		})),
		...configuration.getArtifactPresets(editor.document.uri).map((preset) => ({
			id: `preset:${preset.id}`,
			label: preset.id,
			description: `${artifactDefinitions[preset.artifactKind].label} preset`,
			variant: selectedVariant,
			preset,
		})),
	];
	if (targets.length < 2) {
		await vscode.window.showInformationMessage(
			'Artifact comparison needs at least two variants or configured presets.',
		);
		return;
	}
	const left = await pickComparisonTarget(targets, 'Select the left artifact');
	if (!left) {
		return;
	}
	const compatibleTargets = targets.filter(
		(target) => target.id !== left.id && comparisonTargetsAreCompatible(left, target, compilationService),
	);
	if (compatibleTargets.length === 0) {
		await vscode.window.showInformationMessage(
			`No other configured variant or preset is compatible with "${left.label}".`,
		);
		return;
	}
	const right = await pickComparisonTarget(compatibleTargets, 'Select the right artifact');
	if (!right) {
		return;
	}
	if (targetIsGraph(left) || targetIsGraph(right)) {
		await vscode.window.showInformationMessage(graphComparisonMessage);
		return;
	}
	const allCommonKinds = supportedArtifactKinds.filter(
		(kind) =>
			targetSupportsKind(left, kind, compilationService) && targetSupportsKind(right, kind, compilationService),
	);
	const commonKinds = allCommonKinds.filter((kind) => artifactDefinitions[kind].presentation === 'text');
	if (commonKinds.length === 0) {
		await vscode.window.showWarningMessage(
			allCommonKinds.some((kind) => artifactDefinitions[kind].presentation === 'graph')
				? graphComparisonMessage
				: `"${left.label}" and "${right.label}" do not support a common artifact kind.`,
		);
		return;
	}
	const kind =
		commonKinds.length === 1
			? commonKinds[0]
			: await pickFrom(
					commonKinds,
					(artifactKind) => ({
						label: artifactDefinitions[artifactKind].label,
					}),
					{ title: 'Select the artifact kind to compare' },
				);
	if (!kind) {
		return;
	}
	const leftUri = comparisonUri(editor.document.uri, left, kind);
	const rightUri = comparisonUri(editor.document.uri, right, kind);
	if (leftUri.toString() === rightUri.toString()) {
		await vscode.window.showInformationMessage(
			'These selections resolve to the same artifact. Choose a different variant or preset.',
		);
		return;
	}
	await vscode.commands.executeCommand(
		'vscode.diff',
		leftUri,
		rightUri,
		`${left.label} ↔ ${right.label} — ${artifactDefinitions[kind].label}`,
		{ preview: false },
	);
}

function targetIsGraph(target: ComparisonTarget): boolean {
	return Boolean(target.preset && artifactDefinitions[target.preset.artifactKind].presentation === 'graph');
}

function pickComparisonTarget(
	targets: readonly ComparisonTarget[],
	title: string,
): Promise<ComparisonTarget | undefined> {
	return pickFrom(
		targets,
		(target) => ({
			label: target.label,
			description: target.description,
			iconPath: new vscode.ThemeIcon(
				target.preset ? artifactDefinitions[target.preset.artifactKind].icon : 'git-branch',
			),
		}),
		{ title, matchOnDescription: true },
	);
}

function comparisonTargetsAreCompatible(
	left: ComparisonTarget,
	right: ComparisonTarget,
	compilationService: CompilationService,
): boolean {
	return supportedArtifactKinds.some(
		(kind) =>
			targetSupportsKind(left, kind, compilationService) && targetSupportsKind(right, kind, compilationService),
	);
}

function targetSupportsKind(
	target: ComparisonTarget,
	kind: ArtifactKind,
	compilationService: CompilationService,
): boolean {
	return (
		(!target.preset || target.preset.artifactKind === kind) &&
		compilationService.toolchainRegistry.getArtifactAvailability(target.variant.toolchainProfileId, kind).status ===
			'available'
	);
}

function comparisonUri(source: vscode.Uri, target: ComparisonTarget, kind: ArtifactKind): vscode.Uri {
	return getArtifactUri(
		source,
		target.variant,
		kind,
		target.preset?.id ?? 'default',
		undefined,
	);
}

export function isSupportedSourceDocument(document: vscode.TextDocument): boolean {
	return document.uri.scheme === 'file' && supportedLanguageIdentifiers.has(document.languageId);
}

async function showArtifactStatusActions(artifacts: ArtifactDocumentProvider): Promise<void> {
	const snapshot = artifacts.getActiveArtifactDocumentState();
	if (!snapshot) {
		return;
	}
	const choice = await vscode.window.showQuickPick(
		[
			{
				label: '$(refresh) Refresh Artifact',
				description: 'Regenerate from the current source and settings',
				command: 'coglens.RefreshArtifact',
			},
			...(snapshot.status.state === 'compiling'
				? [
						{
							label: '$(debug-stop) Cancel Generation',
							description: 'Stop the active compilation',
							command: 'coglens.CancelGeneration',
						},
					]
				: []),
			{
				label: '$(go-to-file) Reveal Source',
				description: path.basename(snapshot.identity.sourceLabel),
				command: 'coglens.RevealArtifactSource',
			},
			{
				label: '$(output) Show Log',
				description: 'Open the Cogitator Lens output channel',
				command: 'coglens.ShowLog',
			},
		],
		{
			title: `${snapshot.identity.artifactLabel} · ${statusLabel(snapshot.status.state)}`,
			matchOnDescription: true,
		},
	);
	if (choice) {
		await vscode.commands.executeCommand(choice.command);
	}
}

function statusLabel(state: import('../artifact-document/artifact-generator.js').ArtifactState): string {
	return state[0].toUpperCase() + state.slice(1);
}

async function openWorkspaceSettingsJson(key: string): Promise<void> {
	const command =
		vscode.workspace.workspaceFile || vscode.workspace.workspaceFolders?.length
			? 'workbench.action.openWorkspaceSettingsFile'
			: 'workbench.action.openSettingsJson';
	await vscode.commands.executeCommand(command, { revealSetting: { key, edit: true } });
}
