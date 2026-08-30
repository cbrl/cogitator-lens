import vscode from 'vscode';
import { parseArtifactUri } from '../asm-document/artifact-uri.js';
import { artifactDefinitions } from '../artifacts/core/artifact-definitions.js';
import type { ArtifactPreset } from '../artifacts/ui/presets.js';
import { ConfigurationService } from '../services/configuration-service.js';
import { TreeNode, TreeProvider } from './treedata.js';
import { makeListNode, noneNode } from './tree-helpers.js';

export class ArtifactPresetTreeNode extends TreeNode {
	declare children?: ArtifactPresetTreeNode[];
	preset?: ArtifactPreset;
	scope?: vscode.Uri;

	static from(preset: ArtifactPreset, scope: vscode.Uri | undefined): ArtifactPresetTreeNode {
		const productionOptions = Object.entries(preset.productionOptions);
		const root: ArtifactPresetTreeNode = {
			id: `preset:${preset.id}`,
			label: preset.id,
			description: artifactDefinitions[preset.artifactKind].label,
			tooltip: `Artifact: ${artifactDefinitions[preset.artifactKind].label}`,
			nodeType: 'subtree',
			treeContext: 'artifactPreset',
			iconPath: new vscode.ThemeIcon('symbol-parameter'),
			preset,
			scope,
			children: [
				detailNode('Artifact', artifactDefinitions[preset.artifactKind].label, 'preview'),
				makeListNode('Extra arguments', preset.extraArguments),
				{
					label: 'Production options',
					description: `${productionOptions.length}`,
					nodeType: 'subtree',
					iconPath: new vscode.ThemeIcon('settings-gear'),
					children: productionOptions.length
						? productionOptions.map(([name, enabled]) =>
							detailNode(name, enabled ? 'Enabled' : 'Disabled', 'symbol-boolean'))
						: [noneNode],
				},
			],
		};
		for (const child of root.children ?? []) {
			child.preset = preset;
			child.scope = scope;
		}
		return root;
	}
}

export class ArtifactPresetsTreeProvider extends TreeProvider<ArtifactPresetTreeNode> {
	constructor(private readonly configuration: ConfigurationService) {
		super();
	}

	getChildren(element?: ArtifactPresetTreeNode): ArtifactPresetTreeNode[] | undefined {
		if (element) {
			return element.children;
		}
		const scope = activeConfigurationScope();
		const presets = this.configuration.getArtifactPresets(scope);
		return presets.length
			? [...presets]
				.sort((left, right) => left.id.localeCompare(right.id, undefined, { sensitivity: 'base' }))
				.map(preset => ArtifactPresetTreeNode.from(preset, scope))
			: [{
				label: 'No presets configured',
				description: scope ? 'for this workspace' : undefined,
				tooltip: 'Add a preset to reuse artifact arguments and production options.',
				nodeType: 'text',
				iconPath: new vscode.ThemeIcon('info'),
			}];
	}
}

export function activeConfigurationScope(): vscode.Uri | undefined {
	const active = vscode.window.activeTextEditor?.document.uri;
	return active ? parseArtifactUri(active)?.source ?? (active.scheme === 'file' ? active : undefined) : undefined;
}

function detailNode(label: string, description: string, icon: string): ArtifactPresetTreeNode {
	return {
		label,
		description,
		tooltip: description,
		nodeType: 'text',
		treeContext: 'text',
		iconPath: new vscode.ThemeIcon(icon),
	};
}
