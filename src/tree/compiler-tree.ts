import vscode from 'vscode';
import type { CompilerProfile } from '../types/index.js';
import { CompilerRegistry } from '../compilation/index.js';
import { TreeItem, TreeNode, TreeProvider } from './treedata.js';

export class CompilerTreeNode extends TreeNode {
	profile?: CompilerProfile;
	origin?: string;

	static from(profile: CompilerProfile, origin: string): CompilerTreeNode {
		const root: CompilerTreeNode = {
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
				makeListNode('Defines', profile.defines),
				makeListNode('Include directories', profile.includes),
				makeEnvironmentNode(profile.environment),
				this.capabilitiesNode(profile),
			],
		};
		for (const child of root.children as CompilerTreeNode[]) {
			child.profile = profile;
			child.origin = origin;
		}
		return root;
	}

	private static informationNode(profile: CompilerProfile, origin: string): CompilerTreeNode {
		const details: CompilerTreeNode[] = [
			detailNode('Type', profile.kind, 'symbol-enum'),
			detailNode('Executable', profile.executable, 'file-binary'),
			detailNode('Profile ID', profile.id, 'key'),
			detailNode('Origin', originLabel(origin), 'source-control'),
			detailNode('Include flag', profile.includeFlag, 'symbol-operator'),
			detailNode('Define flag', profile.defineFlag, 'symbol-operator'),
		];
		if (profile.demangler) {
			details.push(detailNode('Demangler', profile.demangler, 'symbol-method'));
		}
		return {
			label: 'Compiler information',
			nodeType: 'subtree',
			iconPath: new vscode.ThemeIcon('gear'),
			children: details,
		};
	}

	private static capabilitiesNode(profile: CompilerProfile): CompilerTreeNode {
		return {
			label: 'Capabilities',
			description: `${Object.values(profile.capabilities).filter(Boolean).length}/3`,
			nodeType: 'subtree',
			iconPath: new vscode.ThemeIcon('tools'),
			children: [
				capabilityNode('Symbol demangling', profile.capabilities.demangle),
				capabilityNode('Intel syntax', profile.capabilities.intelSyntax),
				capabilityNode('Library-code filtering', profile.capabilities.libraryCodeFilter),
			],
		};
	}
}

export class CompilerTreeProvider extends TreeProvider<CompilerTreeNode> {
	constructor(private readonly registry: CompilerRegistry) {
		super();
	}

	getTreeItem(element: CompilerTreeNode): vscode.TreeItem {
		return new TreeItem(element);
	}

	protected createChildren(element?: CompilerTreeNode): CompilerTreeNode[] | undefined {
		if (element) {
			return element.children as CompilerTreeNode[] | undefined;
		}
		return [...this.registry.getProfiles()]
			.sort((left, right) => left.displayName.localeCompare(right.displayName, undefined, { sensitivity: 'base' }))
			.map(profile => CompilerTreeNode.from(profile, this.registry.getOrigin(profile.id) ?? 'unknown'));
	}
}

function detailNode(label: string, value: string, icon: string): CompilerTreeNode {
	return {
		label,
		description: value,
		tooltip: value,
		nodeType: 'text',
		iconPath: new vscode.ThemeIcon(icon),
		treeContext: 'text',
	};
}

function makeListNode(label: string, values: readonly string[]): CompilerTreeNode {
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

function makeEnvironmentNode(environment: Readonly<Record<string, string>>): CompilerTreeNode {
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

function capabilityNode(label: string, supported: boolean): CompilerTreeNode {
	return {
		label,
		description: supported ? 'Supported' : 'Unavailable',
		nodeType: 'text',
		iconPath: new vscode.ThemeIcon(supported ? 'pass-filled' : 'circle-slash'),
	};
}

function originLabel(origin: string): string {
	switch (origin) {
		case 'user': return 'Workspace';
		case 'cmake': return 'CMake';
		case 'compilation-database': return 'Compilation database';
		default: return origin;
	}
}

function sensitiveEnvironmentName(name: string): boolean {
	return /(?:password|token|secret|api[-_]?key)/i.test(name);
}
