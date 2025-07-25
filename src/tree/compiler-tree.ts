import vscode from 'vscode';
import { CompilerBase, ICompiler } from '../compiler';
import { CompilerCache } from '../compile-database';
import _ from 'underscore';
import { TreeNode, TreeItem, TreeProvider } from './treedata';

export class CompilerTreeNode extends TreeNode {
	compiler?: ICompiler;

    static from(instance: CompilerBase): CompilerTreeNode {
        const info = instance.info;

        let result: CompilerTreeNode = {
            label: info.name,
            nodeType: 'subtree',
			treeContext: 'instance',
            iconPath: new vscode.ThemeIcon('chip'), //vscode.Uri.file(path.join(__filename, '..', '..', 'resources', 'compiler.png')),
            compiler: instance,
            children: [],
        };

		let infoNode = CompilerTreeNode.buildCompilerInfoNode(instance);
		result.children!.push(infoNode);

		result.children!.push(...CompilerTreeNode.buildCompilerArgsNodes(instance));

        for (const child of result.children as CompilerTreeNode[]) {
            child.compiler = instance;
        }

        return result;
    }

	private static buildCompilerArgsNodes(compiler: CompilerBase): CompilerTreeNode[] {
		const info = compiler.info;

		const nodes: CompilerTreeNode[] = [];

		const argListNode: CompilerTreeNode = {
			label: 'Arguments',
			nodeType: 'subtree',
			treeContext: 'array',
			iconPath: new vscode.ThemeIcon('list-ordered'),
			children: [] as CompilerTreeNode[],
			objectRef: info,
			attr: 'args',
		};
		TreeNode.populateArrayNodeChildren(
			argListNode,
			info.args ?? [],
			{
				nodeType: 'text',
				treeContext: TreeNode.multiContext('element', 'text', 'editText'),
				compiler: compiler
			}
		);
		nodes.push(argListNode);

		const defineListNode: CompilerTreeNode = {
			label: 'Defines',
			nodeType: 'subtree',
			treeContext: 'array',
			iconPath: new vscode.ThemeIcon('list-ordered'),
			children: [] as CompilerTreeNode[],
			objectRef: info,
			attr: 'defines',
		};
		TreeNode.populateArrayNodeChildren(
			defineListNode,
			info.defines ?? [],
			{
				nodeType: 'text',
				treeContext: TreeNode.multiContext('element', 'text', 'editText'),
				compiler: compiler
			}
		);
		nodes.push(defineListNode);

		const includeListNode: CompilerTreeNode = {
			label: 'Include Directories',
			nodeType: 'subtree',
			treeContext: 'array',
			iconPath: new vscode.ThemeIcon('list-ordered'),
			children: [] as CompilerTreeNode[],
			objectRef: info,
			attr: 'includePaths',
		};
		TreeNode.populateArrayNodeChildren(
			includeListNode,
			info.includePaths ?? [],
			{
				nodeType: 'text',
				treeContext: TreeNode.multiContext('element', 'text', 'editText'),
				compiler: compiler
			}
		);
		nodes.push(includeListNode);

		return nodes;
	}

	private static buildCompilerInfoNode(compiler: CompilerBase): CompilerTreeNode {
		const info = compiler.info;

		const node: CompilerTreeNode = {
			label: 'Info',
			nodeType: 'subtree',
			iconPath: new vscode.ThemeIcon('gear'),
			children: [] as CompilerTreeNode[],
			compiler: compiler
		};

		node.children!.push({
			label: `Type: ${info.type}`,
			nodeType: 'text',
		});

		node.children!.push({
			label: `Path: ${info.exe}`,
			nodeType: 'text',
			treeContext: 'editText',
			objectRef: info,
			attr: 'exe',
		});

		node.children!.push({
			label: `Define Flag: ${info.defineFlag}`,
			nodeType: 'text',
			treeContext: 'editText',
			objectRef: info,
			attr: 'defineFlag'
		});

		node.children!.push({
			label: `Include Flag: ${info.includeFlag}`,
			nodeType: 'text',
			treeContext: 'editText',
			objectRef: info,
			attr: 'includeFlag'
		});

		return node;
	}
}

export class CompilerTreeProvider extends TreeProvider<CompilerTreeNode> {
    private instances!: CompilerCache;

	constructor(cache: CompilerCache) {
		super();
		this.instances = cache;
	}

    public getTreeItem(element: CompilerTreeNode): vscode.TreeItem {
        return new TreeItem(element);
    }

    protected createChildren(element?: CompilerTreeNode) {
		return element ? element?.children : _.map(this.instances.compilers, CompilerTreeNode.from);
    }
}
