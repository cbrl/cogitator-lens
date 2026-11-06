import path from 'path';
import * as vscode from 'vscode';
import type { ActiveArtifact } from '../artifact-document/active-artifact.js';
import type { ArtifactDocumentProvider } from '../artifact-document/artifact-document-provider.js';
import type {
	ArtifactDocumentRegistry,
	ArtifactRegistryDocument,
} from '../artifact-document/artifact-document-registry.js';
import { listingText } from '../artifact-document/artifact-generator.js';
import type {
	ArtifactSnapshot,
	ArtifactSnapshots,
	DerivedDocumentProvider,
} from '../artifact-document/derived-documents.js';
import { artifactDefinitions } from '../artifacts/core/artifact-definitions.js';
import { listingWithColumns } from '../artifacts/core/artifact-views.js';
import type { CompilationService } from '../compilation/index.js';
import type { ConfigurationService } from '../services/configuration-service.js';
import { formatCommandLine, tokenizeCommandLine } from '../tokenize.js';
import { resolveArtifactOptionAvailability } from '../toolchains/toolchain-artifacts.js';
import {
	selectedOptimizationLevel,
	withOptimizationLevel,
	type OptimizationLevel,
} from '../toolchains/optimization-levels.js';
import {
	artifactOptionValue,
	optimizationRemarkCategories,
	type OptimizationRemarkCategory,
	type RenderedTextArtifact,
} from '../types/index.js';

export interface ExperimentCommandDependencies {
	readonly compilationService: CompilationService;
	readonly configuration: ConfigurationService;
	readonly activeArtifact: ActiveArtifact;
	readonly registry: ArtifactDocumentRegistry;
	readonly artifacts: ArtifactDocumentProvider;
	readonly derivedDocuments: DerivedDocumentProvider;
	readonly snapshots: ArtifactSnapshots;
}

/** An item of the artifact status menu. */
export interface StatusAction extends vscode.QuickPickItem {
	run?(): Thenable<unknown>;
}

/** The command line rules of the platform, so a Windows path keeps its backslashes. */
const commandLinePlatform = process.platform === 'win32' ? 'windows' : 'posix';

export function register(context: vscode.ExtensionContext, deps: ExperimentCommandDependencies): void {
	const withArtifact =
		(message: string, action: (document: ArtifactRegistryDocument) => Promise<unknown>) => async () => {
			const document = deps.activeArtifact.document;
			if (document) {
				await action(document);
			} else {
				await vscode.window.showInformationMessage(message);
			}
		};
	context.subscriptions.push(
		vscode.commands.registerCommand(
			'coglens.EditArtifactArguments',
			withArtifact('Open an artifact to edit its compiler arguments.', (document) =>
				editArtifactArguments(document, deps),
			),
		),
		vscode.commands.registerCommand(
			'coglens.SetOptimizationLevel',
			withArtifact('Open an artifact to set its optimization level.', (document) =>
				setOptimizationLevel(document, deps),
			),
		),
		vscode.commands.registerCommand(
			'coglens.CompareWithPrevious',
			withArtifact('Open an artifact to compare it with its previous result.', (document) =>
				compareWithPrevious(document, deps),
			),
		),
		vscode.commands.registerCommand(
			'coglens.SnapshotArtifact',
			withArtifact('Open an artifact to keep a snapshot of it.', (document) => snapshotArtifact(document, deps)),
		),
		vscode.commands.registerCommand(
			'coglens.CompareWithSnapshot',
			withArtifact('Open an artifact to compare it with a snapshot.', (document) =>
				compareWithSnapshot(document, deps),
			),
		),
		vscode.commands.registerCommand('coglens.FilterOptimizationRemarks', () =>
			filterOptimizationRemarks(deps.configuration),
		),
		vscode.commands.registerTextEditorCommand('coglens.CopyWithAddresses', (editor) =>
			copyWithAddresses(editor, deps.artifacts),
		),
	);
}

/** The status menu items that change or compare the artifact. */
export function experimentStatusActions(
	document: ArtifactRegistryDocument,
	deps: ExperimentCommandDependencies,
): StatusAction[] {
	const command = (name: string) => () => vscode.commands.executeCommand(name);
	const edited = deps.registry.editedArguments.get(document.uri);
	const levels = optimizationLevels(document, deps.compilationService);
	const isText = artifactDefinitions[document.identity.artifactKind].presentation === 'text';
	const actions: StatusAction[] = [
		{
			label: '$(edit) Edit Compiler Arguments',
			description:
				edited.length > 0 ? formatCommandLine(edited, commandLinePlatform) : 'Add arguments to this artifact',
			run: command('coglens.EditArtifactArguments'),
		},
	];
	if (levels) {
		const level = selectedOptimizationLevel(effectiveArguments(document, deps), levels);
		actions.push({
			label: '$(dashboard) Set Optimization Level',
			description: level ? `Now ${level.label}` : 'Now the compiler default',
			run: command('coglens.SetOptimizationLevel'),
		});
	}
	if (edited.length > 0) {
		actions.push({
			label: '$(save-as) Save as Preset',
			description: 'Keep the preset and the edited arguments as a new preset',
			run: command('coglens.SaveArtifactOptionsAsPreset'),
		});
	}
	if (isText) {
		if (document.handler.previousArtifact) {
			actions.push({
				label: '$(diff) Compare With Previous Result',
				description: 'Show what the last change did',
				run: command('coglens.CompareWithPrevious'),
			});
		}
		if (document.handler.status.artifact) {
			actions.push({
				label: '$(device-camera) Snapshot Artifact',
				description: 'Keep this result to compare with later',
				run: command('coglens.SnapshotArtifact'),
			});
		}
		if (deps.snapshots.list().length > 0) {
			actions.push({
				label: '$(diff-multiple) Compare With Snapshot',
				run: command('coglens.CompareWithSnapshot'),
			});
		}
	}
	if (document.identity.artifactKind === 'optimization-remarks') {
		const shown = deps.configuration.getOptimizationRemarkCategories();
		actions.push({
			label: '$(filter) Filter Optimization Remarks',
			description: `Now ${optimizationRemarkCategories.filter((category) => shown.has(category)).join(', ') || 'none'}`,
			run: command('coglens.FilterOptimizationRemarks'),
		});
	}
	const toggles = optionToggleActions(document, deps.compilationService);
	if (toggles.length > 0) {
		actions.push(
			{
				label: `Options of each ${artifactDefinitions[document.identity.artifactKind].label} artifact`,
				kind: vscode.QuickPickItemKind.Separator,
			},
			...toggles,
		);
	}
	return actions;
}

async function editArtifactArguments(
	document: ArtifactRegistryDocument,
	deps: ExperimentCommandDependencies,
): Promise<void> {
	const store = deps.registry.editedArguments;
	const levels = optimizationLevels(document, deps.compilationService);
	const value = await vscode.window.showInputBox({
		title: `Compiler Arguments · ${document.identity.artifactLabel}`,
		prompt:
			'These arguments follow the arguments of the variant and the preset. They apply to this artifact only. ' +
			'An empty value removes them.',
		placeHolder: levels?.at(-1)?.arguments.join(' '),
		value: formatCommandLine(store.get(document.uri), commandLinePlatform),
		validateInput: (text) => {
			try {
				tokenizeCommandLine(text, commandLinePlatform);
				return undefined;
			} catch (error) {
				return error instanceof Error ? error.message : String(error);
			}
		},
	});
	if (value !== undefined) {
		await store.set(document.uri, tokenizeCommandLine(value, commandLinePlatform));
	}
}

async function setOptimizationLevel(
	document: ArtifactRegistryDocument,
	deps: ExperimentCommandDependencies,
): Promise<void> {
	const levels = optimizationLevels(document, deps.compilationService);
	if (!levels) {
		await vscode.window.showInformationMessage(
			`Cogitator Lens has no optimization levels for ${document.identity.toolchainLabel}. Run "Edit Compiler Arguments" to add the arguments.`,
		);
		return;
	}
	const store = deps.registry.editedArguments;
	const edited = store.get(document.uri);
	const current = selectedOptimizationLevel(effectiveArguments(document, deps), levels);
	const editedLevel = selectedOptimizationLevel(edited, levels);
	const choice = await vscode.window.showQuickPick(
		[
			{
				label: 'Variant Default',
				description: editedLevel ? undefined : 'Current',
				detail: 'Use the level of the variant and the preset',
				level: undefined as OptimizationLevel | undefined,
			},
			...levels.map((level) => ({
				label: level.label,
				description: level === current ? 'Current' : undefined,
				detail: level.arguments.join(' '),
				level: level as OptimizationLevel | undefined,
			})),
		],
		{ title: `Optimization Level · ${document.identity.toolchainLabel}` },
	);
	if (choice) {
		await store.set(document.uri, withOptimizationLevel(edited, levels, choice.level));
	}
}

function optimizationLevels(
	document: ArtifactRegistryDocument,
	compilationService: CompilationService,
): readonly OptimizationLevel[] | undefined {
	return compilationService.toolchainRegistry.getToolchainById(document.identity.toolchainId)?.definition
		.optimizationLevels;
}

/** The arguments of the variant, the preset, and the edit, in the order that the compiler reads them. */
function effectiveArguments(document: ArtifactRegistryDocument, deps: ExperimentCommandDependencies): string[] {
	const { parsed } = document;
	const variant = deps.compilationService.findVariant(parsed.source, parsed.variantId);
	const preset = deps.compilationService.getArtifactPreset(parsed.artifactKind, parsed.presetId, parsed.source);
	return [
		...(variant?.arguments ?? []),
		...(preset?.extraArguments ?? []),
		...deps.registry.editedArguments.get(document.uri),
	];
}

/** A toggle for each option that the toolchain supports and that the preset does not set. */
function optionToggleActions(
	document: ArtifactRegistryDocument,
	compilationService: CompilationService,
): StatusAction[] {
	const { artifactKind, presetId, toolchainId } = document.identity;
	const profile = compilationService.toolchainRegistry.getToolchainById(toolchainId)?.profile;
	if (!profile) {
		return [];
	}
	const options = compilationService.getArtifactOptions(artifactKind);
	const preset = compilationService.getArtifactPreset(artifactKind, presetId, document.parsed.source);
	return artifactDefinitions[artifactKind].options.flatMap((descriptor): StatusAction[] => {
		const setByPreset =
			descriptor.group === 'production' &&
			preset?.productionOptions[descriptor.id as keyof typeof preset.productionOptions] !== undefined;
		if (
			setByPreset ||
			resolveArtifactOptionAvailability(profile, artifactKind, descriptor.id).status !== 'available'
		) {
			return [];
		}
		const value = artifactOptionValue(options, descriptor.id);
		return [
			{
				label: `${value ? '$(pass-filled)' : '$(circle-large-outline)'} ${descriptor.label}`,
				description: value ? 'On' : 'Off',
				run: async () => compilationService.setArtifactOption(artifactKind, descriptor.id, !value),
			},
		];
	});
}

const remarkCategoryLabels: Readonly<Record<OptimizationRemarkCategory, string>> = {
	passed: 'Passed: optimizations that the compiler did',
	missed: 'Missed: optimizations that the compiler could not do',
	analysis: 'Analysis: other notes of the optimization passes',
};

/** Selects the remark categories that the artifact and the source editors show. */
async function filterOptimizationRemarks(configuration: ConfigurationService): Promise<void> {
	const shown = configuration.getOptimizationRemarkCategories();
	const selected = await vscode.window.showQuickPick(
		optimizationRemarkCategories.map((category) => ({
			label: remarkCategoryLabels[category],
			picked: shown.has(category),
			category,
		})),
		{ title: 'Filter Optimization Remarks', canPickMany: true, placeHolder: 'Select the remarks to show' },
	);
	if (selected) {
		await configuration.updateOptimizationRemarkCategories(selected.map((item) => item.category));
	}
}

function textArtifactOf(document: ArtifactRegistryDocument): RenderedTextArtifact | undefined {
	const artifact = document.handler.status.artifact;
	return artifact?.presentation === 'text' ? artifact : undefined;
}

const graphComparisonMessage = 'Control-flow graphs cannot be compared in the text diff.';

async function compareWithPrevious(
	document: ArtifactRegistryDocument,
	deps: ExperimentCommandDependencies,
): Promise<void> {
	if (artifactDefinitions[document.identity.artifactKind].presentation !== 'text') {
		await vscode.window.showInformationMessage(graphComparisonMessage);
		return;
	}
	const previous = document.handler.previousArtifact;
	if (!previous) {
		await vscode.window.showInformationMessage(
			'This artifact has no earlier result with different text. Save a change to the source, or change an option, and run the command again.',
		);
		return;
	}
	const filename = path.posix.basename(document.uri.path);
	const left = deps.derivedDocuments.create(listingText(previous), filename);
	await vscode.commands.executeCommand('vscode.diff', left, document.uri, `${filename} (Previous ↔ Current)`, {
		preview: false,
	});
}

async function snapshotArtifact(
	document: ArtifactRegistryDocument,
	deps: ExperimentCommandDependencies,
): Promise<void> {
	if (artifactDefinitions[document.identity.artifactKind].presentation !== 'text') {
		await vscode.window.showInformationMessage(graphComparisonMessage);
		return;
	}
	const artifact = textArtifactOf(document);
	if (!artifact) {
		await vscode.window.showInformationMessage('The artifact has no result yet. Wait for the compile to end.');
		return;
	}
	const label = await vscode.window.showInputBox({
		title: 'Snapshot Artifact',
		prompt: 'A name for the snapshot. The snapshot stays until VS Code closes.',
		value: `${document.identity.artifactLabel} ${new Date().toLocaleTimeString()}`,
	});
	if (label === undefined) {
		return;
	}
	const snapshot = deps.snapshots.add(
		document.identity,
		listingText(artifact),
		path.posix.basename(document.uri.path),
		label,
	);
	await vscode.window.showInformationMessage(
		`Kept the snapshot "${snapshot.label}". Run "Compare With Snapshot" to compare an artifact with it.`,
	);
}

async function compareWithSnapshot(
	document: ArtifactRegistryDocument,
	deps: ExperimentCommandDependencies,
): Promise<void> {
	if (artifactDefinitions[document.identity.artifactKind].presentation !== 'text') {
		await vscode.window.showInformationMessage(graphComparisonMessage);
		return;
	}
	const { identity } = document;
	const sameArtifact = (candidate: ArtifactSnapshot): boolean =>
		candidate.identity.sourceUri === identity.sourceUri &&
		candidate.identity.artifactKind === identity.artifactKind;
	const snapshots = deps.snapshots.list();
	if (snapshots.length === 0) {
		await vscode.window.showInformationMessage('No snapshot exists. Run "Snapshot Artifact" first.');
		return;
	}
	const ordered = [...snapshots.filter(sameArtifact), ...snapshots.filter((candidate) => !sameArtifact(candidate))];
	const choice = await vscode.window.showQuickPick(
		ordered.map((snapshot) => ({
			label: snapshot.label,
			description: `${snapshot.identity.artifactLabel} · ${snapshot.identity.variantLabel}`,
			detail: `${path.basename(snapshot.identity.sourceLabel)} · ${new Date(snapshot.createdAt).toLocaleTimeString()}`,
			snapshot,
		})),
		{ title: 'Compare With Snapshot', matchOnDescription: true, matchOnDetail: true },
	);
	if (!choice) {
		return;
	}
	const left = deps.derivedDocuments.create(choice.snapshot.text, choice.snapshot.filename);
	const filename = path.posix.basename(document.uri.path);
	await vscode.commands.executeCommand('vscode.diff', left, document.uri, `${choice.snapshot.label} ↔ ${filename}`, {
		preview: false,
	});
}

/**
 * Copies the selected lines with their address and code byte columns, which are decorations and
 * not text. Without a selection, the command copies the full listing.
 */
async function copyWithAddresses(editor: vscode.TextEditor, artifacts: ArtifactDocumentProvider): Promise<void> {
	const artifact = artifacts.getRenderedArtifact(editor.document.uri);
	if (!artifact) {
		await vscode.window.showInformationMessage('Open an artifact listing to copy it with its addresses.');
		return;
	}
	if (!artifact.lines.some((line) => line.address !== undefined || line.opcodes?.length)) {
		await vscode.window.showInformationMessage('This listing has no address or code byte columns.');
		return;
	}
	const lineNumbers = editor.selections.every((selection) => selection.isEmpty)
		? artifact.lines.map((_line, index) => index)
		: [
				...new Set(
					editor.selections.flatMap((selection) => {
						// A selection that ends at the start of a line does not include that line.
						const end =
							selection.end.character === 0 && selection.end.line > selection.start.line
								? selection.end.line - 1
								: selection.end.line;
						return Array.from(
							{ length: end - selection.start.line + 1 },
							(_value, offset) => selection.start.line + offset,
						);
					}),
				),
			].sort((left, right) => left - right);
	await vscode.env.clipboard.writeText(listingWithColumns(artifact, lineNumbers));
}
