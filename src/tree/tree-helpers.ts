import vscode from 'vscode';
import { TreeNode } from './treedata.js';

export const noneNode: TreeNode = { label: '(none)', nodeType: 'text' };

export function compareLabels(left: string, right: string): number {
	return left.localeCompare(right, undefined, { sensitivity: 'base', numeric: true });
}

export function makeListNode(label: string, values: readonly string[]): TreeNode {
	return {
		label,
		description: `${values.length}`,
		nodeType: 'subtree',
		iconPath: new vscode.ThemeIcon('list-ordered'),
		children: values.length
			? values.map(value => ({ label: value, tooltip: value, nodeType: 'text', treeContext: 'text' }))
			: [noneNode],
	};
}

export function makeEnvironmentNode(environment: Readonly<Record<string, string>>): TreeNode {
	const entries = Object.entries(environment).sort(([left], [right]) => compareLabels(left, right));
	return {
		label: 'Environment overrides',
		description: `${entries.length}`,
		nodeType: 'subtree',
		iconPath: new vscode.ThemeIcon('symbol-variable'),
		children: entries.length
			? entries.map(([name, value]) => ({
				label: name,
				description: value,
				tooltip: `${name}=${value}`,
				nodeType: 'text',
				treeContext: 'text',
			}))
			: [noneNode],
	};
}
