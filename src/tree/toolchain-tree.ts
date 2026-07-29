import vscode from 'vscode';
import type { ToolchainProfile } from '../types/index.js';
import { ToolchainRegistry } from '../compilation/index.js';
import { TreeItem, TreeNode, TreeProvider } from './treedata.js';
import {
	resolveToolchainCapabilities,
	type ResolvedToolchainCapabilities,
} from '../toolchains/toolchain-map.js';
import {
	type ConfigurationOrigin,
	variantProviderDefinitions,
} from '../buildsystems/variant-provider.js';

export class ToolchainTreeNode extends TreeNode {
	profile?: ToolchainProfile;
	origin?: ConfigurationOrigin;

	static from(profile: ToolchainProfile, origin: ConfigurationOrigin): ToolchainTreeNode {
		const root: ToolchainTreeNode = {
			label: profile.displayName,
			description: originLabel(origin),
			tooltip: profile.executable,
			nodeType: 'subtree',
			treeContext: origin === 'user' ? 'instance' : 'derivedInstance',
			iconPath: new vscode.ThemeIcon('chip'),
			profile,
			origin,
			children: [
				this.informationNode(profile, origin),
				makeListNode('Arguments', profile.defaultArguments),
				makeEnvironmentNode(profile.environment),
				makeToolsNode(profile.tools),
				this.capabilitiesNode(profile),
			],
		};
		for (const child of root.children as ToolchainTreeNode[]) {
			child.profile = profile;
			child.origin = origin;
		}
		return root;
	}

	private static informationNode(profile: ToolchainProfile, origin: ConfigurationOrigin): ToolchainTreeNode {
		const details: ToolchainTreeNode[] = [
			detailNode('Type', profile.kind, 'symbol-enum'),
			detailNode('Executable', profile.executable, 'file-binary'),
			detailNode('Profile ID', profile.id, 'key'),
			detailNode('Origin', originLabel(origin), 'source-control'),
		];
		return {
			label: 'Toolchain information',
			nodeType: 'subtree',
			iconPath: new vscode.ThemeIcon('gear'),
			children: details,
		};
	}

	private static capabilitiesNode(profile: ToolchainProfile): ToolchainTreeNode {
		const capabilities = resolveToolchainCapabilities(profile);
		const available = Object.values(capabilities)
			.filter(status => status === 'available' || status === 'selectable' || status === 'inherent')
			.length;
		return {
			label: 'Capabilities',
			description: `${available}/3`,
			nodeType: 'subtree',
			iconPath: new vscode.ThemeIcon('tools'),
			children: [
				capabilityNode('Symbol demangling', capabilities.demangle),
				capabilityNode('Intel syntax', capabilities.intelSyntax),
				capabilityNode('Library-code filtering', capabilities.libraryCodeFilter),
			],
		};
	}
}

function makeToolsNode(tools: Readonly<Record<string, string>>): ToolchainTreeNode {
	const entries = Object.entries(tools);
	return {
		label: 'Auxiliary tools',
		description: `${entries.length}`,
		nodeType: 'subtree',
		iconPath: new vscode.ThemeIcon('tools'),
		children: entries.length
			? entries.map(([name, executable]) => detailNode(name, executable, 'symbol-method'))
			: [{ label: '(none)', nodeType: 'text' }],
	};
}

export class ToolchainTreeProvider extends TreeProvider<ToolchainTreeNode> {
	constructor(private readonly registry: ToolchainRegistry) {
		super();
	}

	getTreeItem(element: ToolchainTreeNode): vscode.TreeItem {
		return new TreeItem(element);
	}

	protected createChildren(element?: ToolchainTreeNode): ToolchainTreeNode[] | undefined {
		if (element) {
			return element.children as ToolchainTreeNode[] | undefined;
		}
		return [...this.registry.getProfiles()]
			.sort((left, right) => left.displayName.localeCompare(right.displayName, undefined, { sensitivity: 'base' }))
			.map(profile => {
				const origin = this.registry.getOrigin(profile.id);
				if (!origin) {
					throw new Error(`Toolchain profile has no configuration origin: ${profile.id}`);
				}
				return ToolchainTreeNode.from(profile, origin);
			});
	}
}

function detailNode(label: string, value: string, icon: string): ToolchainTreeNode {
	return {
		label,
		description: value,
		tooltip: value,
		nodeType: 'text',
		iconPath: new vscode.ThemeIcon(icon),
		treeContext: 'text',
	};
}

function makeListNode(label: string, values: readonly string[]): ToolchainTreeNode {
	return {
		label,
		description: `${values.length}`,
		nodeType: 'subtree',
		iconPath: new vscode.ThemeIcon('list-ordered'),
		children: values.length
			? values.map(value => ({
				label: value,
				tooltip: value,
				nodeType: 'text',
				treeContext: 'text',
			}))
			: [{ label: '(none)', nodeType: 'text' }],
	};
}

function makeEnvironmentNode(environment: Readonly<Record<string, string>>): ToolchainTreeNode {
	const entries = Object.entries(environment)
		.sort(([left], [right]) => left.localeCompare(right, undefined, { sensitivity: 'base' }));
	return {
		label: 'Environment overrides',
		description: `${entries.length}`,
		nodeType: 'subtree',
		iconPath: new vscode.ThemeIcon('symbol-variable'),
		children: entries.length
			? entries.map(([name, value]) => ({
				label: name,
				description: sensitiveEnvironmentName(name) ? '<redacted>' : value,
				tooltip: sensitiveEnvironmentName(name) ? `${name}=<redacted>` : `${name}=${value}`,
				nodeType: 'text',
				treeContext: 'text',
			}))
			: [{ label: '(none)', nodeType: 'text' }],
	};
}

function capabilityNode(
	label: string,
	status: ResolvedToolchainCapabilities[keyof ResolvedToolchainCapabilities],
): ToolchainTreeNode {
	const descriptions: Record<typeof status, string> = {
		available: 'Available',
		unavailable: 'Unavailable',
		unsupported: 'Unsupported',
		selectable: 'Selectable',
		inherent: 'Inherent',
	};
	const supported = status === 'available' || status === 'selectable' || status === 'inherent';
	return {
		label,
		description: descriptions[status],
		nodeType: 'text',
		iconPath: new vscode.ThemeIcon(supported ? 'pass-filled' : 'circle-slash'),
	};
}

function originLabel(origin: ConfigurationOrigin): string {
	return variantProviderDefinitions[origin].label;
}

function sensitiveEnvironmentName(name: string): boolean {
	return /(?:password|token|secret|api[-_]?key)/i.test(name);
}
