import vscode from 'vscode';
import type { IntelSyntaxSupport, ToolchainProfile } from '../types/index.js';
import { ToolchainRegistry } from '../compilation/index.js';
import { TreeNode, TreeProvider } from './treedata.js';
import { detailNode, groupNode, makeEnvironmentNode, makeListNode, noneNode } from './tree-helpers.js';
import { getToolchainDefinition, resolveArtifactAvailability } from '../toolchains/toolchain-map.js';
import { artifactDefinitions, supportedArtifactKinds } from '../artifacts/core/artifact-definitions.js';
import { type ConfigurationOrigin, variantProviderDefinitions } from '../buildsystems/variant-provider.js';

export interface ToolchainTreeNode extends TreeNode {
	profile?: ToolchainProfile;
	origin?: ConfigurationOrigin;
}

export function buildToolchainTreeNode(profile: ToolchainProfile, origin: ConfigurationOrigin): ToolchainTreeNode {
	const root: ToolchainTreeNode = {
		label: profile.displayName,
		description: originLabel(origin),
		tooltip: profile.executable,
		nodeType: 'subtree',
		treeContext: origin === 'user' ? 'userToolchain' : 'derivedInstance',
		iconPath: new vscode.ThemeIcon('chip'),
		profile,
		origin,
		children: [
			toolchainInformationNode(profile, origin),
			makeListNode('Arguments', profile.defaultArguments),
			makeEnvironmentNode(profile.environment),
			makeToolsNode(profile.tools),
			capabilitiesNode(profile),
		],
	};
	for (const child of root.children ?? []) {
		Object.assign(child, { profile, origin });
	}
	return root;
}

function toolchainInformationNode(profile: ToolchainProfile, origin: ConfigurationOrigin): ToolchainTreeNode {
	const details: ToolchainTreeNode[] = [
		detailNode('Type', profile.kind, 'symbol-enum'),
		detailNode('Executable', profile.executable, 'file-binary'),
		detailNode('Profile ID', profile.id, 'key'),
		detailNode('Origin', originLabel(origin), 'source-control'),
	];
	return groupNode('Toolchain information', 'gear', details);
}

function capabilitiesNode(profile: ToolchainProfile): ToolchainTreeNode {
	const definition = getToolchainDefinition(profile.kind);
	const capabilities: Array<{
		label: string;
		status: 'available' | 'unavailable' | IntelSyntaxSupport;
	}> = supportedArtifactKinds.map((kind) => ({
		label: artifactDefinitions[kind].label,
		status: resolveArtifactAvailability(profile, kind).status,
	}));
	if (definition.artifacts.assembly.status === 'available') {
		capabilities.push({
			label: 'Symbol demangling',
			status: profile.tools.demangler ? 'available' : 'unavailable',
		});
		capabilities.push({
			label: 'Intel syntax',
			status: definition.intelSyntax ?? 'unsupported',
		});
	}
	const available = capabilities
		.map((capability) => capability.status)
		.filter((status) => status === 'available' || status === 'selectable' || status === 'inherent').length;
	return {
		...groupNode(
			'Capabilities',
			'tools',
			capabilities.map((capability) => capabilityNode(capability.label, capability.status)),
		),
		description: `${available}/${capabilities.length}`,
	};
}

function makeToolsNode(tools: Readonly<Record<string, string>>): ToolchainTreeNode {
	const entries = Object.entries(tools);
	return groupNode(
		'Auxiliary tools',
		'tools',
		entries.length
			? entries.map(([name, executable]) => detailNode(name, executable, 'symbol-method'))
			: [noneNode],
		entries.length,
	);
}

export class ToolchainTreeProvider extends TreeProvider<ToolchainTreeNode> {
	constructor(private readonly registry: ToolchainRegistry) {
		super();
	}

	getChildren(element?: ToolchainTreeNode): ToolchainTreeNode[] | undefined {
		if (element) {
			return element.children;
		}
		return [...this.registry.getProfiles()]
			.sort((left, right) =>
				left.displayName.localeCompare(right.displayName, undefined, { sensitivity: 'base' }),
			)
			.map((profile) => {
				const origin = this.registry.getOrigin(profile.id);
				if (!origin) {
					throw new Error(`Toolchain profile has no configuration origin: ${profile.id}`);
				}
				return buildToolchainTreeNode(profile, origin);
			});
	}
}

function capabilityNode(label: string, status: 'available' | 'unavailable' | IntelSyntaxSupport): ToolchainTreeNode {
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
