import vscode from 'vscode';
import type { ParseFiltersAndOutputOptions } from '../parsers/filters.interfaces.js';
import { CompilationService } from '../compilation/index.js';
import { TreeItem, TreeNode, TreeProvider } from './treedata.js';

export class GlobalOptionsNode extends TreeNode {
	static createFilterTree(filters: ParseFiltersAndOutputOptions): GlobalOptionsNode[] {
		const definitions: Array<{ label: string; attr: keyof ParseFiltersAndOutputOptions; tooltip: string }> = [
			{ label: 'Hide unused labels', attr: 'labels', tooltip: 'Remove labels that are not referenced' },
			{ label: 'Hide library code', attr: 'libraryCode', tooltip: 'Hide code from system libraries' },
			{ label: 'Hide directives', attr: 'directives', tooltip: 'Hide assembler directives' },
			{ label: 'Hide comment-only lines', attr: 'commentOnly', tooltip: 'Remove comment-only lines' },
			{ label: 'Trim horizontal whitespace', attr: 'trim', tooltip: 'Remove excessive horizontal whitespace' },
			{ label: 'Debug calls', attr: 'debugCalls', tooltip: 'Show debug-related calls' },
			{ label: 'Optimized output', attr: 'optOutput', tooltip: 'Show optimized assembly output' },
		];
		return [{
			label: 'Output Filters',
			nodeType: 'subtree',
			iconPath: new vscode.ThemeIcon('filter'),
			children: definitions.map(definition => ({
				label: definition.label,
				nodeType: 'checkbox',
				treeContext: 'filters',
				objectRef: filters,
				attr: definition.attr,
				tooltip: definition.tooltip,
			})),
		}];
	}
}

export class GlobalOptionsTreeProvider extends TreeProvider<GlobalOptionsNode> {
	constructor(private readonly compilationService: CompilationService) {
		super();
	}

	getTreeItem(element: GlobalOptionsNode): vscode.TreeItem {
		return new TreeItem(element);
	}

	protected createChildren(element?: GlobalOptionsNode): GlobalOptionsNode[] | undefined {
		return element?.children as GlobalOptionsNode[] | undefined
			?? GlobalOptionsNode.createFilterTree(this.compilationService.globalFilterOptions);
	}
}
