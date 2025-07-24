import vscode from 'vscode';
import { CompilerOutputOptions, ParseFiltersAndOutputOptions } from '../parsers/filters.interfaces';
import { CompilationInfo, CompileManager } from '../compile-database';
import { TreeNode, TreeItem, TreeProvider } from './treedata';
import { CompilationInfoTreeNode } from './compilation-info-tree';

export class GlobalOptionsNode extends TreeNode {
	static createFilterTree(filterOptions: ParseFiltersAndOutputOptions, defaultCompileInfo: CompilationInfo): GlobalOptionsNode[] {
		const rootNodes: GlobalOptionsNode[] = [];

		// Default Compile Options
		const fileElem = {
			basename: 'Default Compile Options',
			path: 'Default',
			description: 'Default compile options used for files without auto-discovered compile info',
			iconPath: new vscode.ThemeIcon('settings-gear'),
			children: []
		};

		const compileInfoNode = CompilationInfoTreeNode.makeFileNode(fileElem, defaultCompileInfo, undefined);

		rootNodes.push(compileInfoNode);

		// Assembly Output Filters
		const outputFiltersRoot: GlobalOptionsNode = {
			label: 'Output Filters',
			nodeType: 'subtree',
			treeContext: 'filters',
			iconPath: new vscode.ThemeIcon('filter'),
			children: [],
		};

		const outputFilterNodes = [
			{ label: 'Hide unused labels', attr: 'labels', description: 'Remove labels that are not referenced' },
			{ label: 'Hide library code', attr: 'libraryCode', description: 'Hide code from system libraries' },
			{ label: 'Hide directives', attr: 'directives', description: 'Hide assembler directives' },
			{ label: 'Hide comment-only lines', attr: 'commentOnly', description: 'Remove lines containing only comments' },
			{ label: 'Trim horizontal whitespace', attr: 'trim', description: 'Remove excessive horizontal whitespace' },
			{ label: 'Debug calls', attr: 'debugCalls', description: 'Show debug-related function calls' },
			{ label: 'Don\'t mask filenames', attr: 'dontMaskFilenames', description: 'Show actual filenames instead of masked ones' },
			{ label: 'Optimized output', attr: 'optOutput', description: 'Show optimized assembly output' }
		];

		for (const filter of outputFilterNodes) {
			const child: GlobalOptionsNode = {
				label: filter.label,
				nodeType: 'checkbox',
				treeContext: 'filters',
				objectRef: filterOptions,
				attr: filter.attr,
				tooltip: filter.description
			};
			outputFiltersRoot.children!.push(child);
		}

		rootNodes.push(outputFiltersRoot);

/* TODO: Future implementation of compiler options
		// Compiler Output Options
		const compilerOptionsRoot: GlobalOptionsNode = {
			label: 'Compiler Options',
			nodeType: 'subtree',
			treeContext: 'filters',
			iconPath: new vscode.ThemeIcon('tools'),
			children: [],
		};

		const compilerOptionNodes = [
			{ label: 'Binary output', attr: 'binary', description: 'Generate binary assembly output' },
			{ label: 'Binary object', attr: 'binaryObject', description: 'Generate binary object output' },
			{ label: 'Execute', attr: 'execute', description: 'Execute the compiled code' },
			{ label: 'Demangle symbols', attr: 'demangle', description: 'Demangle C++ symbol names' },
			{ label: 'Intel syntax', attr: 'intel', description: 'Use Intel assembly syntax instead of AT&T' },
			{ label: 'Verbose demangling', attr: 'verboseDemangling', description: 'Show verbose demangled output' }
		];

		for (const option of compilerOptionNodes) {
			const child: GlobalOptionsNode = {
				label: option.label,
				nodeType: 'checkbox',
				treeContext: 'filters',
				iconPath: new vscode.ThemeIcon('settings-gear'),
				objectRef: compilerOptions,
				attr: option.attr,
				tooltip: option.description
			};
			compilerOptionsRoot.children!.push(child);
		}

		rootNodes.push(compilerOptionsRoot);
*/

		return rootNodes;
	}
}

export class GlobalOptionsTreeProvider extends TreeProvider<GlobalOptionsNode> {
	private compileManager: CompileManager;

	constructor(compileManager: CompileManager) {
		super();
		this.compileManager = compileManager;
	}

	public getTreeItem(element: GlobalOptionsNode): vscode.TreeItem {
		return new TreeItem(element);
	}

	protected createChildren(element?: GlobalOptionsNode): GlobalOptionsNode[] | undefined {
		if (element) {
			return element.children;
		} else {
			return GlobalOptionsNode.createFilterTree(this.compileManager.globalFilterOptions, this.compileManager.compilationInfo.defaultCompileInfo);
		}
	}
}
