import vscode from 'vscode';
import { CompilationService } from '../compilation/index.js';
import type {
	ArtifactKind,
	ArtifactOptionDescriptor,
	ArtifactOptionId,
	ArtifactOptions,
	ToolchainProfile,
} from '../types/index.js';
import { parseArtifactUri } from '../artifact-document/artifact-uri.js';
import { TreeNode, TreeProvider } from './treedata.js';
import {
	resolveArtifactAvailability,
	resolveArtifactOptionAvailability,
} from '../toolchains/toolchain-map.js';
import { artifactDefinitions } from '../artifacts/core/artifact-definitions.js';

interface SelectedArtifact {
	readonly profile?: ToolchainProfile;
	readonly kind: ArtifactKind;
	readonly source?: vscode.Uri;
	readonly variantLabel?: string;
	readonly presetId?: string;
	readonly outputId?: string;
}

export class GlobalOptionsNode extends TreeNode {
	declare children?: GlobalOptionsNode[];
	artifactKind?: ArtifactKind;

	static createFilterTree(
		options: ArtifactOptions,
		profile?: ToolchainProfile,
		kind: ArtifactKind = 'assembly',
	): GlobalOptionsNode[] {
		if (!profile) {
			return [{
				label: 'No toolchain selected',
				description: 'Open a supported source file',
				tooltip: 'Open a source file with a compilation variant to configure artifact options.',
				nodeType: 'text',
				disabled: true,
			}];
		}

		const availability = resolveArtifactAvailability(profile, kind);
		if (availability.status !== 'available') {
			return [{
				label: artifactDefinitions[kind].label,
				description: availability.status === 'unsupported' ? 'Unsupported' : 'Unavailable',
				tooltip: availability.explanation,
				nodeType: 'text',
				disabled: true,
			}];
		}

		const descriptors: readonly ArtifactOptionDescriptor[] = artifactDefinitions[kind].options;
		const production = descriptors.filter(descriptor => descriptor.group === 'production');
		const display = descriptors.filter(descriptor => descriptor.group === 'display');
		const groups: GlobalOptionsNode[] = [];
		if (production.length) {
			groups.push({
				label: 'Production Options',
				nodeType: 'subtree',
				iconPath: new vscode.ThemeIcon('settings-gear'),
				children: production.map(descriptor =>
					optionNode(options, profile, kind, descriptor)),
			});
		}
		if (display.length) {
			groups.push({
				label: 'Display Options',
				nodeType: 'subtree',
				iconPath: new vscode.ThemeIcon('filter'),
				children: display.map(descriptor =>
					optionNode(options, profile, kind, descriptor)),
			});
		}
		return groups.length
			? groups
			: [{
				label: 'No options',
				description: artifactDefinitions[kind].label,
				nodeType: 'text',
			}];
	}
}

export class GlobalOptionsTreeProvider extends TreeProvider<GlobalOptionsNode> {
	constructor(private readonly compilationService: CompilationService) {
		super();
	}

	getChildren(element?: GlobalOptionsNode): GlobalOptionsNode[] | undefined {
		if (element?.children) {
			return element.children;
		}
		const selected = this.selectedArtifact();
		return [
			bindingNode(selected),
			...GlobalOptionsNode.createFilterTree(
			this.compilationService.getArtifactOptions(selected.kind),
			selected.profile,
			selected.kind,
			),
		];
	}

	private selectedArtifact(): SelectedArtifact {
		let source = vscode.window.activeTextEditor?.document.uri;
		let kind: ArtifactKind = 'assembly';
		const identity = source ? parseArtifactUri(source) : undefined;
		if (identity) {
			source = identity.source;
			kind = identity.artifactKind;
		}
		if (!source || source.scheme !== 'file') {
			source = vscode.window.visibleTextEditors.find(editor =>
				editor.document.uri.scheme === 'file')?.document.uri;
		}
		const variant = identity
			? this.compilationService.getVariants(identity.source)
				.find(candidate => candidate.id === identity.variantId)
			: source ? this.compilationService.getSelectedVariant(source) : undefined;
		return {
			kind,
			source,
			variantLabel: variant?.displayLabel,
			presetId: identity?.presetId,
			outputId: identity?.artifactOutputId,
			profile: variant
				? this.compilationService.toolchainRegistry
					.getToolchainById(variant.toolchainProfileId)?.profile
				: undefined,
		};
	}
}

function bindingNode(selected: SelectedArtifact): GlobalOptionsNode {
	const artifactLabel = artifactDefinitions[selected.kind].label;
	const toolchainLabel = selected.profile?.displayName ?? 'No toolchain selected';
	const binding = [
		`Artifact: ${artifactLabel}`,
		`Output: ${selected.outputId ?? artifactLabel}`,
		`Toolchain: ${toolchainLabel}`,
		...(selected.variantLabel ? [`Variant: ${selected.variantLabel}`] : []),
		...(selected.presetId ? [`Preset: ${selected.presetId}`] : []),
		...(selected.source ? [`Source: ${selected.source.fsPath}`] : []),
	];
	return {
		id: 'active-artifact-binding',
		label: artifactLabel,
		description: `${selected.outputId ?? 'Default output'} · ${toolchainLabel}`,
		tooltip: binding.join('\n'),
		nodeType: 'text',
		iconPath: new vscode.ThemeIcon('link'),
	};
}

function optionNode(
	options: ArtifactOptions,
	profile: ToolchainProfile,
	kind: ArtifactKind,
	descriptor: ArtifactOptionDescriptor,
): GlobalOptionsNode {
	const capability = resolveArtifactOptionAvailability(profile, kind, descriptor.id);
	return {
		label: descriptor.label,
		nodeType: 'checkbox',
		artifactKind: kind,
		optionId: descriptor.id,
		checked: optionValue(options, descriptor.id),
		tooltip: capability.status === 'available'
			? descriptor.description
			: capability.explanation,
		description: capability.status === 'available'
			? undefined
			: capability.status === 'unsupported'
				? 'Unsupported'
				: capability.reason === 'inherent'
					? 'Inherent'
					: 'Unavailable',
		disabled: capability.status !== 'available',
	};
}

function optionValue(options: ArtifactOptions, id: ArtifactOptionId): boolean {
	if (Object.hasOwn(options.production, id)) {
		return options.production[id as keyof ArtifactOptions['production']];
	}
	return options.display[id as keyof ArtifactOptions['display']];
}
