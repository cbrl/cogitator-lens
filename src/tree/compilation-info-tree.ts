import vscode from "vscode";
import { CompilationInfo, CompileInfoDatabase } from "../compile-database";
import { TreeNode, TreeItem, TreeProvider } from './treedata';
import _ from 'underscore';
import path from "path";

type FileTreeElement = {
	basename: string;
	path: string;
	children: FileTreeElement[];
	parent?: FileTreeElement;
}

function filePathsToTree(paths: string[]) {
	const results: FileTreeElement[] = [];

	return paths.reduce((currentResults, currentPath) => {
		const pathParts = path.normalize(currentPath).split(path.sep).filter(value => value.length > 0);
		const byPath: Record<string, FileTreeElement> = {};

		pathParts.reduce((nodes, basename, index, arr) => {
			let node = nodes.find((node) => node.basename === basename);
			const curPath = arr.slice(0, index + 1).join(path.sep);
			const parentPath = arr.slice(0, index).join(path.sep);

			if (!node) {
				node = {
					basename,
					path: curPath,
					parent: byPath[parentPath],
					children: [],
				};

				nodes.push(node);
			}

			byPath[curPath] = node;

			return node.children;
		}, currentResults);

		return currentResults;
	}, results);
}

function isSubdirectory(parent: string, child: string): boolean {
	const relative = path.relative(parent, child);
	return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export class CompilationInfoTreeNode extends TreeNode {
	public static build(compileInfo: CompileInfoDatabase) {
		let insideWorkspace = new Map<string, string[]>();
		let outsideWorkspace: string[] = [];

		for (const file of compileInfo.info.keys()) {
			let isInWorkspace = false;

			if (vscode.workspace.workspaceFolders !== undefined) {
				for (const folder of vscode.workspace.workspaceFolders) {
					if (isSubdirectory(folder.uri.fsPath, file)) {
						isInWorkspace = true;

						if (insideWorkspace.get(folder.uri.fsPath) === undefined) {
							insideWorkspace.set(folder.uri.fsPath, []);
						}

						insideWorkspace.get(folder.uri.fsPath)!.push(file);
						break;
					}
				}
			}

			if (!isInWorkspace) {
				// Is there ever going to be known compile info for a file that's not in a workspace?
				outsideWorkspace.push(file);
			}
		}

		let defaultNode = undefined;
		if (compileInfo.defaultCompileInfo !== undefined) {
			const fileElem = { basename: 'Default', path: 'Default', children: [] };
			defaultNode = CompilationInfoTreeNode.makeFileNode(fileElem, compileInfo.defaultCompileInfo, undefined);
		}

		let workspaceNodes = Array.from(insideWorkspace.entries()).flatMap(([workspace, items]) => CompilationInfoTreeNode.makeTree(items, compileInfo, workspace));
		let outsideNodes = CompilationInfoTreeNode.makeTree(outsideWorkspace, compileInfo);

		for (let node of workspaceNodes) {
			node.iconPath = new vscode.ThemeIcon('repo' /*'project'*/ /*'library'*/);
		}

		return _.flatten([defaultNode, workspaceNodes, outsideNodes]).filter(node => node !== undefined);
	}

	private static makeTree(info: string[], compileInfo: CompileInfoDatabase, workspace?: string): CompilationInfoTreeNode[] {
		const workspaceRelative = info.map(value => value.replace(path.dirname(workspace ?? ''), ''));

		return filePathsToTree(workspaceRelative).map(item => CompilationInfoTreeNode.makeItem(item, compileInfo, workspace));
	}

	private static makeItem(elem: FileTreeElement, compileInfo: CompileInfoDatabase, workspace?: string): CompilationInfoTreeNode {
		if (elem.children.length > 0) {
			const result: CompilationInfoTreeNode = {
				label: `${elem.basename}`,
				nodeType: 'subtree',
				iconPath: vscode.ThemeIcon.Folder,
				children: elem.children.map(child => CompilationInfoTreeNode.makeItem(child, compileInfo, workspace))
			};

			return result;
		}
		else {
			const fullPath = path.join(path.dirname(workspace ?? ''), elem.path);
			const info = compileInfo.getCompilationInfo(vscode.Uri.file(fullPath))!;
			return this.makeFileNode(elem, info, workspace);
		}
	}

	private static makeFileNode(elem: FileTreeElement, compileInfo: CompilationInfo, workspace?: string): CompilationInfoTreeNode {
		let result: CompilationInfoTreeNode = {
			label: `${elem.basename}`,
			nodeType: 'subtree',
			iconPath: vscode.ThemeIcon.File,
			children: [] as CompilationInfoTreeNode[],
		};

		const compiler: CompilationInfoTreeNode = {
			label: `Compiler: ${compileInfo.compilerName}`,
			nodeType: 'text',
			treeContext: 'editText',
			objectRef: compileInfo,
			attr: 'compilerName'
		};
		result.children!.push(compiler);

		// Compiler arguments
		const args: CompilationInfoTreeNode = {
			label: 'Arguments',
			nodeType: 'subtree',
			treeContext: 'array',
			iconPath: new vscode.ThemeIcon('list-tree'),
			objectRef: compileInfo,
			attr: 'args'
		};
		TreeNode.populateArrayNodeChildren(args, compileInfo.args, { nodeType: 'text', treeContext: TreeNode.multiContext('element', 'editText') });
		result.children!.push(args);

		// Definitions
		const defs: CompilationInfoTreeNode = {
			label: 'Defines',
			nodeType: 'subtree',
			treeContext: 'array',
			iconPath: new vscode.ThemeIcon('list-tree'),
			objectRef: compileInfo,
			attr: 'defines'
		};
		TreeNode.populateArrayNodeChildren(defs, compileInfo.defines, { nodeType: 'text', treeContext: TreeNode.multiContext('element', 'editText') });
		result.children!.push(defs);

		// Include directories
		const includes: CompilationInfoTreeNode = {
			label: 'Includes',
			nodeType: 'subtree',
			treeContext: 'array',
			iconPath: new vscode.ThemeIcon('list-tree'),
			objectRef: compileInfo,
			attr: 'includes'
		};
		TreeNode.populateArrayNodeChildren(includes, compileInfo.includes, { nodeType: 'text', treeContext: TreeNode.multiContext('element', 'editText') });
		result.children!.push(includes);

		return result;
	}
}

export class CompilationInfoTreeProvider extends TreeProvider<CompilationInfoTreeNode> {
	private compileInfo: CompileInfoDatabase;

	constructor(compileInfo: CompileInfoDatabase) {
		super();
		this.compileInfo = compileInfo;
	}

	public getTreeItem(element: CompilationInfoTreeNode): vscode.TreeItem {
		return new TreeItem(element);
	}

	protected createChildren(element?: CompilationInfoTreeNode) {
		return element ? element?.children : CompilationInfoTreeNode.build(this.compileInfo);
	}
}
