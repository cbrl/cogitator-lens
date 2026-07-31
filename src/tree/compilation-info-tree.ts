import path from 'path';
import vscode from 'vscode';
import type { CompilationVariant } from '../types/index.js';
import { CompilationService } from '../compilation/index.js';
import { TreeNode, TreeProvider } from './treedata.js';
import { compareLabels, makeEnvironmentNode, makeListNode } from './tree-helpers.js';
import {
	type ConfigurationOrigin,
	variantProviderDefinitions,
} from '../buildsystems/variant-provider.js';

type GroupKey = 'project' | 'target' | 'configuration';

interface SourcePathNode {
	label: string;
	children: Map<string, SourcePathNode>;
	variants: CompilationVariant[];
}

interface WorkspaceVariantGroup {
	folder?: vscode.WorkspaceFolder;
	variants: CompilationVariant[];
}

export class CompilationInfoTreeNode extends TreeNode {
	declare children?: CompilationInfoTreeNode[];
	parent?: CompilationInfoTreeNode;
	source?: vscode.Uri;
	variant?: CompilationVariant;

	static build(compilationService: CompilationService): CompilationInfoTreeNode[] {
		const groups = new Map<string, WorkspaceVariantGroup>();
		for (const source of compilationService.getAllSources()) {
			for (const variant of compilationService.getVariants(source)) {
				const folder = vscode.workspace.getWorkspaceFolder(variant.source);
				const key = folder?.uri.toString() ?? 'external';
				const group = groups.get(key) ?? { folder, variants: [] };
				group.variants.push(variant);
				groups.set(key, group);
			}
		}

		const roots = [...groups.values()]
			.sort((left, right) => compareLabels(left.folder?.name ?? 'External Sources', right.folder?.name ?? 'External Sources'))
			.map(group => this.workspaceNode(group, compilationService));
		attachParents(roots);
		return roots;
	}

	private static workspaceNode(
		group: WorkspaceVariantGroup,
		compilationService: CompilationService,
	): CompilationInfoTreeNode {
		const label = group.folder?.name ?? 'External Sources';
		return {
			label,
			description: group.folder?.uri.fsPath,
			tooltip: group.folder?.uri.fsPath ?? 'Sources outside the open workspace folders',
			nodeType: 'subtree',
			iconPath: new vscode.ThemeIcon(group.folder ? 'repo' : 'globe'),
			children: this.groupVariants(group.variants, 'project', group.folder, compilationService),
		};
	}

	private static groupVariants(
		variants: readonly CompilationVariant[],
		key: GroupKey,
		folder: vscode.WorkspaceFolder | undefined,
		compilationService: CompilationService,
	): CompilationInfoTreeNode[] {
		const groups = new Map<string, CompilationVariant[]>();
		for (const variant of variants) {
			const label = groupLabel(variant, key);
			const group = groups.get(label) ?? [];
			group.push(variant);
			groups.set(label, group);
		}

		return [...groups.entries()]
			.sort(([left], [right]) => compareLabels(left, right))
			.map(([label, groupedVariants]) => {
				const next = nextGroupKey(key);
				return {
					label,
					nodeType: 'subtree',
					iconPath: new vscode.ThemeIcon(groupIcon(key)),
					children: next
						? this.groupVariants(groupedVariants, next, folder, compilationService)
						: this.sourceTree(groupedVariants, folder, compilationService),
				};
			});
	}

	private static sourceTree(
		variants: readonly CompilationVariant[],
		folder: vscode.WorkspaceFolder | undefined,
		compilationService: CompilationService,
	): CompilationInfoTreeNode[] {
		const root: SourcePathNode = { label: '', children: new Map(), variants: [] };
		for (const variant of variants) {
			const relativePath = folder
				? path.relative(folder.uri.fsPath, variant.source.fsPath)
				: externalDisplayPath(variant.source.fsPath);

			const segments = path.normalize(relativePath).split(path.sep).filter(Boolean);
			let current = root;

			for (const segment of segments) {
				let child = current.children.get(segment);
				if (!child) {
					child = { label: segment, children: new Map(), variants: [] };
					current.children.set(segment, child);
				}
				current = child;
			}
			current.variants.push(variant);
		}

		return this.sourcePathChildren(root, compilationService);
	}

	private static sourcePathChildren(
		node: SourcePathNode,
		compilationService: CompilationService,
	): CompilationInfoTreeNode[] {
		return [...node.children.values()]
			.sort((left, right) => {
				const leftDirectory = left.children.size > 0;
				const rightDirectory = right.children.size > 0;
				return leftDirectory === rightDirectory
					? compareLabels(left.label, right.label)
					: leftDirectory ? -1 : 1;
			})
			.map(child => {
				if (child.children.size > 0) {
					return {
						label: child.label,
						nodeType: 'subtree',
						iconPath: vscode.ThemeIcon.Folder,
						children: this.sourcePathChildren(child, compilationService),
					};
				}

				const source = child.variants[0]?.source;
				return {
					label: child.label,
					description: child.variants.length > 1 ? `${child.variants.length} variants` : undefined,
					tooltip: source?.fsPath,
					nodeType: 'subtree',
					treeContext: 'compilationSource',
					iconPath: vscode.ThemeIcon.File,
					source,
					command: source
						? {
							command: 'vscode.open',
							title: 'Open Source',
							arguments: [source],
						}
						: undefined,
					children: child.variants
						.sort((left, right) => compareLabels(left.displayLabel, right.displayLabel))
						.map(variant => this.variantNode(variant, compilationService)),
				};
			});
	}

	private static variantNode(
		variant: CompilationVariant,
		compilationService: CompilationService,
	): CompilationInfoTreeNode {
		const backend = compilationService.toolchainRegistry.getToolchainById(variant.toolchainProfileId);
		return {
			label: variant.displayLabel,
			description: providerLabel(variant.provider),
			tooltip: variant.id,
			nodeType: 'subtree',
			treeContext: variant.provider === 'manual'
				? 'manualCompilationVariant'
				: 'compilationVariant',
			iconPath: new vscode.ThemeIcon('symbol-interface'),
			source: variant.source,
			variant,
			children: [
				{
					label: 'Toolchain',
					description: backend?.profile.displayName ?? variant.toolchainProfileId,
					tooltip: backend?.profile.executable,
					nodeType: 'text',
					iconPath: new vscode.ThemeIcon('chip'),
					treeContext: 'text',
				},
				{
					label: 'Working directory',
					description: variant.workingDirectory,
					tooltip: variant.workingDirectory,
					nodeType: 'text',
					iconPath: new vscode.ThemeIcon('folder'),
					treeContext: 'text',
				},
				makeListNode('Arguments', variant.arguments),
				makeEnvironmentNode(variant.environment),
			],
		};
	}
}

export class CompilationInfoTreeProvider extends TreeProvider<CompilationInfoTreeNode> {
	private roots?: CompilationInfoTreeNode[];

	constructor(private readonly compilationService: CompilationService) {
		super();
	}

	getChildren(element?: CompilationInfoTreeNode): CompilationInfoTreeNode[] | undefined {
		return element?.children
			?? (this.roots ??= CompilationInfoTreeNode.build(this.compilationService));
	}

	getParent(element: CompilationInfoTreeNode): CompilationInfoTreeNode | undefined {
		return element.parent;
	}

	override refresh(): void {
		this.roots = undefined;
		super.refresh();
	}

	findSource(source: vscode.Uri): CompilationInfoTreeNode | undefined {
		const roots = this.roots ??= CompilationInfoTreeNode.build(this.compilationService);
		return findSourceNode(roots, source);
	}
}

function groupLabel(variant: CompilationVariant, key: GroupKey): string {
	switch (key) {
		case 'project': return variant.project?.trim() || `${providerLabel(variant.provider)} project`;
		case 'target': return variant.target?.trim() || 'Default target';
		case 'configuration': return variant.configuration?.trim() || 'Default configuration';
	}
}

function nextGroupKey(key: GroupKey): GroupKey | undefined {
	switch (key) {
		case 'project': return 'target';
		case 'target': return 'configuration';
		case 'configuration': return undefined;
	}
}

function groupIcon(key: GroupKey): string {
	switch (key) {
		case 'project': return 'project';
		case 'target': return 'target';
		case 'configuration': return 'settings-gear';
	}
}

function externalDisplayPath(filePath: string): string {
	const parsed = path.parse(filePath);
	const withoutRoot = filePath.slice(parsed.root.length);
	return parsed.name ? path.join(parsed.root.replace(/[\\/:]+/g, ''), withoutRoot) : withoutRoot;
}

function providerLabel(provider: string): string {
	if (provider === 'manual') {
		return 'Workspace';
	}
	return Object.hasOwn(variantProviderDefinitions, provider)
		? variantProviderDefinitions[provider as ConfigurationOrigin].label
		: provider;
}

function attachParents(
	nodes: readonly CompilationInfoTreeNode[],
	parent?: CompilationInfoTreeNode,
): void {
	for (const node of nodes) {
		node.parent = parent;
		attachParents(node.children ?? [], node);
	}
}

function findSourceNode(
	nodes: readonly CompilationInfoTreeNode[],
	source: vscode.Uri,
): CompilationInfoTreeNode | undefined {
	for (const node of nodes) {
		if (node.source?.toString() === source.toString() && !node.variant) {
			return node;
		}
		const found = findSourceNode(node.children ?? [], source);
		if (found) {
			return found;
		}
	}
	return undefined;
}
