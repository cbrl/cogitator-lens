import path from 'path';
import * as vscode from 'vscode';
import {
	getArtifactUri,
	parseArtifactUri,
	type ArtifactDocumentProvider,
} from '../artifact-document/artifact-document-provider.js';
import type { ActiveArtifact } from '../artifact-document/active-artifact.js';
import { ArtifactGenerator, type ArtifactState } from '../artifact-document/artifact-generator.js';
import {
	artifactDefinitions,
	generatedCodeKinds,
	getArtifactKind,
	supportedArtifactKinds,
} from '../artifacts/core/artifact-definitions.js';
import {
	partitionArtifactPickerChoices,
	recentArtifactKinds,
	withRecentUse,
	type ArtifactPickerChoice,
} from '../artifacts/ui/artifact-picker.js';
import { effectiveArtifactPresets, type ArtifactPreset } from '../artifacts/ui/presets.js';
import {
	functionRanges,
	matchingFunctions,
	type ArtifactViewOptions,
	type FunctionRange,
} from '../artifacts/core/artifact-views.js';
import { toolchainComparisonVariant } from '../compilation/comparison-variants.js';
import { failureDetails } from '../compilation/compilation-service.js';
import { getToolchainDefinition } from '../toolchains/toolchain-map.js';
import type { CompilationService } from '../compilation/index.js';
import {
	maximumListingLineLimit,
	minimumListingLineLimit,
	parseListingLineLimit,
} from '../compilation/listing-limit.js';
import { CompilationError } from '../types/index.js';
import * as logger from '../logger.js';
import type { ConfigurationService } from '../services/configuration-service.js';
import { getArtifactOutputChoices } from '../toolchains/toolchain-artifacts.js';
import type { TreeNode } from '../tree/treedata.js';
import type {
	ArtifactKind,
	CompilationVariant,
	RenderedTextArtifact,
	ToolchainKind,
	ToolchainProfile,
} from '../types/index.js';
import { pickFrom } from '../ui/quick-input.js';
import type { GraphPanelManager } from '../webview/graph-panel-manager.js';
import { experimentStatusActions, type ExperimentCommandDependencies, type StatusAction } from './experiment.js';
import { isSupportedSourceDocument, resolveSourceVariant } from './variants.js';

export interface ArtifactCommandDependencies extends ExperimentCommandDependencies {
	readonly configuration: ConfigurationService;
	readonly artifacts: ArtifactDocumentProvider;
	readonly activeArtifact: ActiveArtifact;
	readonly graphPanels: GraphPanelManager;
}

/** What `coglens.OpenArtifact` accepts from a key binding, so a key can open one kind or preset. */
export interface OpenArtifactArguments {
	readonly kind?: ArtifactKind;
	readonly preset?: string;
}

/** The global state key of the artifact kinds that the user opened last. */
const recentKindsKey = 'coglens.recentArtifactKinds';

export function register(context: vscode.ExtensionContext, deps: ArtifactCommandDependencies): void {
	const { compilationService, configuration, artifacts, activeArtifact } = deps;
	const recentKinds = {
		get: () => recentArtifactKinds(context.globalState.get(recentKindsKey)),
		use: (kind: ArtifactKind) => context.globalState.update(recentKindsKey, withRecentUse(recentKinds.get(), kind)),
	};
	context.subscriptions.push(
		// The explorer gives a file URI, and a key binding can give OpenArtifactArguments.
		vscode.commands.registerCommand('coglens.OpenArtifact', async (argument?: unknown) => {
			const target = await openArtifactTarget(argument);
			if (target) {
				await openArtifact(target.document, target.request, deps, recentKinds);
			}
		}),
		vscode.commands.registerTextEditorCommand('coglens.OpenControlFlowGraph', (editor) =>
			openArtifact(editor.document, { kind: 'control-flow-graph' }, deps, recentKinds),
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
			const document = activeArtifact.document;
			if (document) {
				artifacts.requestRefresh(document.uri);
			} else {
				await vscode.window.showInformationMessage('Open an artifact to refresh it.');
			}
		}),
		vscode.commands.registerCommand('coglens.CancelGeneration', async () => {
			if (!activeArtifact.document?.handler.cancel()) {
				await vscode.window.showInformationMessage('The active artifact is not being generated.');
			}
		}),
		vscode.commands.registerCommand('coglens.ShowLog', () => logger.logChannel.show()),
		vscode.commands.registerCommand('coglens.RevealArtifactSource', async () => {
			const snapshot = activeArtifact.document?.snapshot;
			if (snapshot) {
				const activeEditor = vscode.window.activeTextEditor;
				const mappedSource = activeEditor
					? artifacts.getRenderedArtifact(activeEditor.document.uri)?.lines[
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
		vscode.commands.registerCommand('coglens.ShowArtifactStatus', async () => showArtifactStatusActions(deps)),
		...[
			['coglens.OpenToolchainSettingsJson', 'coglens.toolchains'],
			['coglens.OpenCompileSettingsJson', 'coglens.compileVariants'],
			['coglens.OpenArtifactSettingsJson', 'coglens.artifactOptions'],
			['coglens.OpenPresetSettingsJson', 'coglens.artifactPresets'],
		].map(([command, key]) => vscode.commands.registerCommand(command, () => openWorkspaceSettingsJson(key))),
	);
}

/** The source and the request of an Open Artifact command, from its argument or the active editor. */
async function openArtifactTarget(
	argument: unknown,
): Promise<{ readonly document: vscode.TextDocument; readonly request: OpenArtifactArguments } | undefined> {
	if (argument instanceof vscode.Uri) {
		// The explorer gives the file. Show it, so the artifact opens beside it and maps its lines.
		const editor = await vscode.window.showTextDocument(argument, { preview: false });
		return { document: editor.document, request: {} };
	}
	const request = openArtifactArguments(argument);
	if (!request) {
		await vscode.window.showErrorMessage(
			'Open Artifact accepts { "kind": "<artifact kind>", "preset": "<preset>" }. ' +
				`The artifact kinds are ${supportedArtifactKinds.join(', ')}.`,
		);
		return undefined;
	}
	// A command link, such as one in the walkthrough, runs while no text editor has the focus.
	const document =
		vscode.window.activeTextEditor?.document ??
		vscode.window.visibleTextEditors.find((editor) => isSupportedSourceDocument(editor.document))?.document;
	if (!document) {
		await vscode.window.showInformationMessage('Open a source file to open its artifacts.');
		return undefined;
	}
	return { document, request };
}

/** Reads the arguments of a key binding. Nothing, or an argument that is not an object, means no choice. */
export function openArtifactArguments(argument: unknown): OpenArtifactArguments | undefined {
	if (argument === undefined || argument === null || typeof argument !== 'object' || Array.isArray(argument)) {
		return {};
	}
	const { kind, preset } = argument as Record<string, unknown>;
	const artifactKind = typeof kind === 'string' ? getArtifactKind(kind) : undefined;
	if ((kind !== undefined && !artifactKind) || (preset !== undefined && typeof preset !== 'string')) {
		return undefined;
	}
	return {
		...(artifactKind ? { kind: artifactKind } : {}),
		...(typeof preset === 'string' ? { preset } : {}),
	};
}

interface RecentArtifactKinds {
	get(): ArtifactKind[];
	use(kind: ArtifactKind): Thenable<void>;
}

async function openArtifact(
	sourceDocument: vscode.TextDocument,
	request: OpenArtifactArguments,
	deps: ArtifactCommandDependencies,
	recentKinds: RecentArtifactKinds,
): Promise<void> {
	const { compilationService, artifacts, graphPanels, configuration } = deps;
	if (!isSupportedSourceDocument(sourceDocument)) {
		await vscode.window.showWarningMessage(
			'Cogitator Lens supports saved, file-backed sources declared by its toolchains.',
		);
		return;
	}
	const variant = await resolveSourceVariant(sourceDocument, deps);
	if (!variant) {
		return;
	}
	const backend = compilationService.toolchainRegistry.getToolchainById(variant.toolchainProfileId);
	if (!backend) {
		await vscode.window.showErrorMessage(`Toolchain profile not found: ${variant.toolchainProfileId}`);
		return;
	}
	let kind = request.kind;
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
			recentKinds.get(),
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
	if (outputChoices.length > 1) {
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
	const presets = [...effectiveArtifactPresets(configuration.getArtifactPresets(sourceDocument.uri), kind).values()];
	if (request.preset !== undefined && !presets.some((candidate) => candidate.id === request.preset)) {
		await vscode.window.showErrorMessage(
			`The preset "${request.preset}" does not exist for ${artifactDefinitions[kind].label}.`,
		);
		return;
	}
	const preset =
		request.preset !== undefined
			? presets.find((candidate) => candidate.id === request.preset)
			: presets.length === 1
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
	void recentKinds.use(kind);
	const artifactUri = getArtifactUri(sourceDocument.uri, variant, kind, preset.id, artifactOutput?.id);
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

export interface ComparisonTarget {
	readonly id: string;
	readonly label: string;
	readonly description: string;
	readonly variant: CompilationVariant;
	readonly preset?: ArtifactPreset;
	/** Whether the target uses another toolchain without the arguments of the selected variant. */
	readonly argumentsDropped?: boolean;
}

/** The part of the toolchain registry that decides which artifact kinds a target supports. */
export type ArtifactAvailabilityLookup = Pick<CompilationService['toolchainRegistry'], 'getArtifactAvailability'>;

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
	const selectedVariant = await resolveSourceVariant(editor.document, { compilationService, configuration });
	if (!selectedVariant) {
		return;
	}
	const registry = compilationService.toolchainRegistry;
	const configuredTargets = comparisonTargets(
		compilationService.getVariants(editor.document.uri),
		configuration.getArtifactPresets(editor.document.uri),
		selectedVariant,
	);
	const targets = [
		...configuredTargets,
		...toolchainComparisonTargets(
			compilationService.getLanguageToolchains(editor.document.languageId),
			editor.document.languageId,
			selectedVariant,
			registry.getToolchainById(selectedVariant.toolchainProfileId)?.profile.kind,
			configuredTargets,
		),
	];
	if (targets.length < 2) {
		await vscode.window.showInformationMessage(
			'Artifact comparison needs at least two variants, toolchains, or configured presets.',
		);
		return;
	}
	const left = await pickComparisonTarget(targets, 'Select the left artifact');
	if (!left) {
		return;
	}
	const compatibleTargets = compatibleComparisonTargets(left, targets, registry);
	if (compatibleTargets.length === 0) {
		await vscode.window.showInformationMessage(
			`No other variant, toolchain, or preset is compatible with "${left.label}".`,
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
	const { textKinds, hasGraphKind } = commonComparisonKinds(left, right, registry);
	if (textKinds.length === 0) {
		await vscode.window.showWarningMessage(
			hasGraphKind
				? graphComparisonMessage
				: `"${left.label}" and "${right.label}" do not support a common artifact kind.`,
		);
		return;
	}
	const kind =
		textKinds.length === 1
			? textKinds[0]
			: await pickFrom(
					textKinds,
					(artifactKind) => ({
						label: artifactDefinitions[artifactKind].label,
					}),
					{ title: 'Select the artifact kind to compare' },
				);
	if (!kind) {
		return;
	}
	const views = await pickComparisonViews(editor.document.uri, left, right, kind, compilationService);
	if (!views) {
		return;
	}
	const leftUri = comparisonUri(editor.document.uri, left, kind, views.left);
	const rightUri = comparisonUri(editor.document.uri, right, kind, views.right);
	if (leftUri.toString() === rightUri.toString()) {
		await vscode.window.showInformationMessage(
			'These selections resolve to the same artifact. Choose a different variant or preset.',
		);
		return;
	}
	const dropped = [left, right].filter((target) => target.argumentsDropped);
	if (dropped.length > 0) {
		void vscode.window.showWarningMessage(
			`${dropped.map((target) => `"${target.label}"`).join(' and ')} reads other compiler arguments than ` +
				`"${selectedVariant.displayLabel}". The comparison does not use the arguments of that variant.`,
		);
	}
	const leftName = views.left.functionName;
	const rightName = views.right.functionName;
	const scope =
		leftName === undefined ? '' : leftName === rightName ? ` · ${leftName}` : ` · ${leftName} ↔ ${rightName}`;
	await vscode.commands.executeCommand(
		'vscode.diff',
		leftUri,
		rightUri,
		`${left.label} ↔ ${right.label} — ${artifactDefinitions[kind].label}${scope}`,
		{ preview: false },
	);
}

/** The view of each side of a comparison. One function can have another name on each side. */
interface ComparisonViews {
	readonly left: ArtifactViewOptions;
	readonly right: ArtifactViewOptions;
}

/**
 * Asks how to show the two listings: in full or as one function, and with or without normalized
 * labels and addresses. For one function, both listings compile first. Two dialects name one
 * function in different ways, so the right side can need its own selection.
 */
async function pickComparisonViews(
	source: vscode.Uri,
	left: ComparisonTarget,
	right: ComparisonTarget,
	kind: ArtifactKind,
	compilationService: CompilationService,
): Promise<ComparisonViews | undefined> {
	if (!generatedCodeKinds.has(kind)) {
		return { left: {}, right: {} };
	}
	const choice = await vscode.window.showQuickPick(
		[
			{ label: 'Full Listing', view: {} as ArtifactViewOptions, oneFunction: false },
			{
				label: 'Full Listing, Normalized',
				detail: 'Renumber local labels and hide addresses, so the diff shows the changed instructions',
				view: { normalized: true },
				oneFunction: false,
			},
			{ label: 'One Function', detail: 'Select a function of the left listing', view: {}, oneFunction: true },
			{
				label: 'One Function, Normalized',
				detail: 'Select a function, and renumber its local labels and hide its addresses',
				view: { normalized: true },
				oneFunction: true,
			},
		],
		{ title: 'Compare the full listing or one function' },
	);
	if (!choice || !choice.oneFunction) {
		return choice && { left: choice.view, right: choice.view };
	}
	const listings = await comparisonListings(source, [left, right], kind, compilationService);
	if (!listings) {
		return undefined;
	}
	const [leftFunctions, rightFunctions] = listings.map(functionRanges);
	for (const [target, functions] of [
		[left, leftFunctions],
		[right, rightFunctions],
	] as const) {
		if (functions.length === 0) {
			await vscode.window.showInformationMessage(
				`The ${artifactDefinitions[kind].label} listing of "${target.label}" has no functions.`,
			);
			return undefined;
		}
	}
	const selected = await pickFrom(leftFunctions, (range) => ({ label: range.name, description: lineCount(range) }), {
		title: 'Select the function to compare',
		matchOnDescription: false,
	});
	if (!selected) {
		return undefined;
	}
	const matched = await pickMatchingFunction(selected.name, rightFunctions, right);
	return (
		matched && {
			left: { ...choice.view, functionName: selected.name },
			right: { ...choice.view, functionName: matched.name },
		}
	);
}

/** Compiles the listing of each target, so the user can select its functions. */
async function comparisonListings(
	source: vscode.Uri,
	targets: readonly ComparisonTarget[],
	kind: ArtifactKind,
	compilationService: CompilationService,
): Promise<RenderedTextArtifact[] | undefined> {
	const generators = targets.flatMap((target) => {
		const uri = comparisonUri(source, target, kind);
		const parsed = parseArtifactUri(uri);
		return parsed
			? [new ArtifactGenerator(source, uri, parsed.variantId, kind, parsed.presetId, compilationService)]
			: [];
	});
	try {
		if (generators.length !== targets.length) {
			return undefined;
		}
		const results = await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: `Reading the functions of ${targets.map((target) => `"${target.label}"`).join(' and ')}`,
				cancellable: true,
			},
			(_progress, token) => Promise.allSettled(generators.map((generator) => generator.update(token))),
		);
		const listings: RenderedTextArtifact[] = [];
		for (const [index, result] of results.entries()) {
			if (result.status === 'rejected') {
				if (!(result.reason instanceof vscode.CancellationError)) {
					await vscode.window.showErrorMessage(
						`"${targets[index].label}" did not compile: ${failureDetails(result.reason)}`,
					);
				}
				return undefined;
			}
			if (result.value.presentation !== 'text') {
				return undefined;
			}
			listings.push(result.value);
		}
		return listings;
	} finally {
		generators.forEach((generator) => generator.dispose());
	}
}

/**
 * The function of the right listing to compare with a function of the left listing. An equal name
 * or one function with the same base name needs no selection. Otherwise the user selects one, and
 * the functions with the same base name come first.
 */
async function pickMatchingFunction(
	name: string,
	functions: readonly FunctionRange[],
	target: ComparisonTarget,
): Promise<FunctionRange | undefined> {
	const matches = matchingFunctions(name, functions);
	if (matches.length === 1) {
		return matches[0];
	}
	const others = functions.filter((range) => !matches.includes(range));
	return pickFrom(
		[...matches, ...others],
		(range) => ({
			label: range.name,
			description: matches.includes(range) ? `Same name · ${lineCount(range)}` : lineCount(range),
		}),
		{ title: `Select the function of "${target.label}" to compare with ${name}`, matchOnDescription: false },
	);
}

function lineCount(range: FunctionRange): string {
	const count = range.endLine - range.startLine + 1;
	return `${count} line${count === 1 ? '' : 's'}`;
}

/** The variants of a source, then each configured preset applied to the selected variant. */
export function comparisonTargets(
	variants: readonly CompilationVariant[],
	presets: readonly ArtifactPreset[],
	selectedVariant: CompilationVariant,
): ComparisonTarget[] {
	return [
		...variants.map((variant) => ({
			id: `variant:${variant.id}`,
			label: variant.displayLabel,
			description: 'Compilation variant',
			variant,
		})),
		...presets.map((preset) => ({
			id: `preset:${preset.id}`,
			label: preset.id,
			description: `${artifactDefinitions[preset.artifactKind].label} preset`,
			variant: selectedVariant,
			preset,
		})),
	];
}

/**
 * A target for each other toolchain that compiles the language of the source. The target keeps the
 * settings of the selected variant when the toolchain reads the same arguments.
 */
export function toolchainComparisonTargets(
	profiles: readonly ToolchainProfile[],
	languageId: string,
	selectedVariant: CompilationVariant,
	selectedKind: ToolchainKind | undefined,
	existing: readonly ComparisonTarget[],
): ComparisonTarget[] {
	const used = new Set(existing.map((target) => target.variant.toolchainProfileId));
	return profiles
		.filter(
			(profile) =>
				!used.has(profile.id) && getToolchainDefinition(profile.kind).languageIdentifiers.includes(languageId),
		)
		.map((profile) => {
			const { variant, argumentsDropped } = toolchainComparisonVariant(selectedVariant, selectedKind, profile);
			return {
				id: `toolchain:${profile.id}`,
				label: profile.displayName,
				description: argumentsDropped
					? `Toolchain · without the arguments of ${selectedVariant.displayLabel}`
					: `Toolchain · settings of ${selectedVariant.displayLabel}`,
				variant,
				...(argumentsDropped ? { argumentsDropped } : {}),
			};
		});
}

/** The other targets that share at least one artifact kind with the left target. */
export function compatibleComparisonTargets(
	left: ComparisonTarget,
	targets: readonly ComparisonTarget[],
	registry: ArtifactAvailabilityLookup,
): ComparisonTarget[] {
	return targets.filter(
		(target) =>
			target.id !== left.id &&
			supportedArtifactKinds.some(
				(kind) => targetSupportsKind(left, kind, registry) && targetSupportsKind(target, kind, registry),
			),
	);
}

/** The text artifact kinds that both targets support, and whether they also share a graph kind. */
export function commonComparisonKinds(
	left: ComparisonTarget,
	right: ComparisonTarget,
	registry: ArtifactAvailabilityLookup,
): { readonly textKinds: ArtifactKind[]; readonly hasGraphKind: boolean } {
	const common = supportedArtifactKinds.filter(
		(kind) => targetSupportsKind(left, kind, registry) && targetSupportsKind(right, kind, registry),
	);
	return {
		textKinds: common.filter((kind) => artifactDefinitions[kind].presentation === 'text'),
		hasGraphKind: common.some((kind) => artifactDefinitions[kind].presentation === 'graph'),
	};
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
				target.preset
					? artifactDefinitions[target.preset.artifactKind].icon
					: target.id.startsWith('toolchain:')
						? 'tools'
						: 'git-branch',
			),
		}),
		{ title, matchOnDescription: true },
	);
}

function targetSupportsKind(
	target: ComparisonTarget,
	kind: ArtifactKind,
	registry: ArtifactAvailabilityLookup,
): boolean {
	return (
		(!target.preset || target.preset.artifactKind === kind) &&
		registry.getArtifactAvailability(target.variant.toolchainProfileId, kind).status === 'available'
	);
}

export function comparisonUri(
	source: vscode.Uri,
	target: ComparisonTarget,
	kind: ArtifactKind,
	view: ArtifactViewOptions = {},
): vscode.Uri {
	return getArtifactUri(source, target.variant, kind, target.preset?.id ?? 'default', undefined, view);
}

async function showArtifactStatusActions(deps: ArtifactCommandDependencies): Promise<void> {
	const { activeArtifact, configuration } = deps;
	const document = activeArtifact.document;
	if (!document) {
		return;
	}
	const { identity, status } = document.snapshot;
	const command = (name: string) => () => vscode.commands.executeCommand(name);
	const actions: StatusAction[] = [
		{
			label: '$(refresh) Refresh Artifact',
			description: 'Regenerate from the current source and settings',
			run: command('coglens.RefreshArtifact'),
		},
		...(document.handler.generating
			? [
					{
						label: '$(debug-stop) Cancel Generation',
						description: 'Stop the active compilation',
						run: command('coglens.CancelGeneration'),
					},
				]
			: []),
		...truncationActions(status, configuration),
		...experimentStatusActions(document, deps),
		{ label: '', kind: vscode.QuickPickItemKind.Separator },
		{
			label: '$(go-to-file) Reveal Source',
			description: path.basename(identity.sourceLabel),
			run: command('coglens.RevealArtifactSource'),
		},
		{
			label: '$(output) Show Log',
			description: 'Open the Cogitator Lens output channel',
			run: command('coglens.ShowLog'),
		},
	];
	const choice = await vscode.window.showQuickPick(actions, {
		title: `${identity.artifactLabel} · ${statusLabel(status.state)}`,
		matchOnDescription: true,
	});
	await choice?.run?.();
}

/** The action that raises the limit which cut the output: the process output or the listing lines. */
function truncationActions(status: ActiveArtifactStatus, configuration: ConfigurationService): StatusAction[] {
	if (status.state === 'failed' && status.error instanceof CompilationError && status.error.truncated) {
		return [
			{
				label: '$(settings) Raise Process Output Limit',
				description: 'The compiler wrote more output than coglens.processOutputLimit allows',
				run: () =>
					vscode.commands.executeCommand('workbench.action.openSettings', 'coglens.processOutputLimit'),
			},
		];
	}
	if (status.artifact?.truncated) {
		return [
			{
				label: '$(settings) Raise Listing Line Limit',
				description: `The listing stops at ${configuration.getListingLineLimit()} lines`,
				run: () => raiseListingLineLimit(configuration),
			},
		];
	}
	return [];
}

type ActiveArtifactStatus = NonNullable<ActiveArtifact['document']>['snapshot']['status'];

async function raiseListingLineLimit(configuration: ConfigurationService): Promise<void> {
	const current = configuration.getListingLineLimit();
	const value = await vscode.window.showInputBox({
		title: 'Listing Line Limit',
		prompt: 'The number of lines that binary disassembly and LLVM IR listings show',
		value: String(Math.min(current * 2, maximumListingLineLimit)),
		validateInput: (text) =>
			parseListingLineLimit(text) === undefined
				? `Type a whole number from ${minimumListingLineLimit} to ${maximumListingLineLimit}.`
				: undefined,
	});
	const limit = value === undefined ? undefined : parseListingLineLimit(value);
	if (limit !== undefined) {
		await configuration.updateListingLineLimit(limit);
	}
}

function statusLabel(state: ArtifactState): string {
	return state[0].toUpperCase() + state.slice(1);
}

async function openWorkspaceSettingsJson(key: string): Promise<void> {
	const command =
		vscode.workspace.workspaceFile || vscode.workspace.workspaceFolders?.length
			? 'workbench.action.openWorkspaceSettingsFile'
			: 'workbench.action.openSettingsJson';
	await vscode.commands.executeCommand(command, { revealSetting: { key, edit: true } });
}
