import vscode from 'vscode';
import { TreeNode } from './treedata.js';

export const noneNode: TreeNode = { label: '(none)', nodeType: 'text' };

export function compareLabels(left: string, right: string): number {
	return left.localeCompare(right, undefined, { sensitivity: 'base', numeric: true });
}

export function detailNode(label: string, value: string, icon: string): TreeNode {
	return {
		label,
		description: value,
		tooltip: value,
		nodeType: 'text',
		iconPath: new vscode.ThemeIcon(icon),
		treeContext: 'text',
	};
}

export function groupNode(
	label: string,
	icon: string,
	children: TreeNode[],
	count?: number,
): TreeNode {
	return {
		label,
		description: count === undefined ? undefined : `${count}`,
		nodeType: 'subtree',
		iconPath: new vscode.ThemeIcon(icon),
		children,
	};
}

export function messageNode(label: string, description?: string, tooltip?: string): TreeNode {
	return { label, description, tooltip, nodeType: 'text' };
}

export function makeListNode(label: string, values: readonly string[]): TreeNode {
	return groupNode(
		label,
		'list-ordered',
		values.length
			? values.map(value => ({ label: value, tooltip: value, nodeType: 'text', treeContext: 'text' }))
			: [noneNode],
		values.length,
	);
}

export function makeEnvironmentNode(environment: Readonly<Record<string, string>>): TreeNode {
	const entries = Object.entries(environment).sort(([left], [right]) => compareLabels(left, right));
	return groupNode(
		'Environment overrides',
		'symbol-variable',
		entries.length
			? entries.map(([name, value]) => ({
				label: name,
				description: value,
				tooltip: `${name}=${value}`,
				nodeType: 'text',
				treeContext: 'text',
			}))
			: [noneNode],
		entries.length,
	);
}
