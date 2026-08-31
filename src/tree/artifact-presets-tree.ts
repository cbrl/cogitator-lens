import vscode from 'vscode';
import { parseArtifactUri } from '../artifact-document/artifact-uri.js';
import { artifactDefinitions } from '../artifacts/core/artifact-definitions.js';
import type { ArtifactPreset } from '../artifacts/ui/presets.js';
import { ConfigurationService } from '../services/configuration-service.js';
import { TreeNode, TreeProvider } from './treedata.js';
import { detailNode, groupNode, makeListNode, messageNode, noneNode } from './tree-helpers.js';

export interface ArtifactPresetTreeNode extends TreeNode {
	preset?: ArtifactPreset;
	scope?: vscode.Uri;
}

export function buildArtifactPresetTreeNode(
	preset: ArtifactPreset,
	scope: vscode.Uri | undefined,
): ArtifactPresetTreeNode {
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
			groupNode(
				'Production options',
				'settings-gear',
				productionOptions.length
					? productionOptions.map(([name, enabled]) =>
						detailNode(name, enabled ? 'Enabled' : 'Disabled', 'symbol-boolean'))
					: [noneNode],
				productionOptions.length,
			),
		],
	};
	for (const child of root.children ?? []) {
		Object.assign(child, { preset, scope });
	}
	return root;
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
				.map(preset => buildArtifactPresetTreeNode(preset, scope))
			: [{
				...messageNode(
					'No presets configured',
					scope ? 'for this workspace' : undefined,
					'Add a preset to reuse artifact arguments and production options.',
				),
				iconPath: new vscode.ThemeIcon('info'),
			}];
	}
}

export function activeConfigurationScope(): vscode.Uri | undefined {
	const active = vscode.window.activeTextEditor?.document.uri;
	return active ? parseArtifactUri(active)?.source ?? (active.scheme === 'file' ? active : undefined) : undefined;
}
