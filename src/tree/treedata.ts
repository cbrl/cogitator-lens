import assert from "assert";
import vscode from "vscode";

export type TreeItemSpecifier = 'checkbox' | 'subtree' | 'text';
export type TreeContextSpecifier = 'array' | 'editText' | 'element' | 'filters' | 'instance' | 'pickFile' | 'text';

export class TreeNode {
	label?: string;
	nodeType?: TreeItemSpecifier;
	iconPath?: string | vscode.Uri | vscode.ThemeIcon | { light: string | vscode.Uri; dark: string | vscode.Uri }; // The icon to display in the tree view
	children?: TreeNode[];

	/**
	 * The tag to identify different nodes. Context taken from nodeType if null.
	 */
	treeContext?: TreeContextSpecifier;

	/**
	 * If the node refers to a value stored in some object, this will be a reference to the containing object.
	 */
	objectRef?: any;

	/**
	 * If the node refers to a value stored in some object, this will be the name of the attribute within the object.
	 */
	attr?: string | number;

	/**
	 * A reference to the tree that owns this node. Automatically set by the tree.
	 */
	tree?: TreeProvider<TreeNode>;

	static multiContext(...args: string[]): string {
		return args.join('&');
	}

	static populateArrayChildren(node: TreeNode, array: any[], options: { nodeType: TreeItemSpecifier, [key: string]: any }): void {
		if (node.children === undefined) {
			node.children = [];
		}

		array.forEach((value, index) => {
			const child = Object.assign(new TreeNode(), {
				label: `[${index}]: ${value}`,
				treeContext: 'element',
				objectRef: array,
				attr: index
			}, options);

			node.children!.push(child);
		});
	}
}

export class TreeItem implements vscode.TreeItem {
    contextValue?: string;
    label?: string | vscode.TreeItemLabel;
    checkboxState?: vscode.TreeItemCheckboxState;
    collapsibleState?: vscode.TreeItemCollapsibleState;
    iconPath?: string | vscode.Uri | vscode.ThemeIcon | { light: string | vscode.Uri; dark: string | vscode.Uri };
    command?: vscode.Command;

    constructor(node: TreeNode) {
        const { label, nodeType, treeContext, iconPath, objectRef, attr } = node;

        this.label = label;
        this.iconPath = iconPath;
        this.contextValue = treeContext ?? nodeType;

        if (nodeType === 'subtree') {
            this.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
        }
		else if (nodeType === 'checkbox') {
			assert(objectRef !== undefined && attr !== undefined);

			// While the object and attribute identifier can't be undefined, the actual attribute can be.
            const value = (objectRef[attr] as boolean) ?? false;

			this.checkboxState = value
				? vscode.TreeItemCheckboxState.Checked
				: vscode.TreeItemCheckboxState.Unchecked;
        }
    }
}

export abstract class TreeProvider<NodeType extends TreeNode> implements vscode.TreeDataProvider<NodeType> {
    protected _onDidChangeTreeData = new vscode.EventEmitter<NodeType | undefined>();

	public get onDidChangeTreeData() {
		return this._onDidChangeTreeData.event;
	}

    public refresh(): void {
        this._onDidChangeTreeData.fire(undefined);
    }

	public refreshItem(node: NodeType): void {
		this._onDidChangeTreeData.fire(node);
	}

    public abstract getTreeItem(element: NodeType): vscode.TreeItem;

    public getChildren(element?: NodeType): vscode.ProviderResult<NodeType[]> {
		const children = this.createChildren(element);

		children?.forEach(child => child.tree = this);

		return children;
	}

	protected abstract createChildren(element?: NodeType): NodeType[] | undefined;
}
