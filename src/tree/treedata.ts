import vscode from "vscode";
import type { ArtifactOptionId } from '../types/index.js';

/**
 * Specifies the type of item in the tree view.
 */
export type TreeItemSpecifier = 'checkbox' | 'subtree' | 'text';

/**
 * Specifies the context in which a tree item is used. This will be the value of vscode.TreeItem.contextValue,
 * and can be used to limit commands to specific menu items based on the context.
 */
export type TreeContextSpecifier = 'derivedInstance' | 'disabled' | 'filters' | 'instance' | 'text';

export class TreeNode {
	/**
	 * The label to display in the tree view.
	 */
	label?: string;

	/**
	 * The type of node. This is used to determine how the node is displayed in the tree view.
	 */
	nodeType?: TreeItemSpecifier;

	/**
	 * The icon to display in the tree view.
	 */
	iconPath?: string | vscode.Uri | vscode.ThemeIcon | { light: string | vscode.Uri; dark: string | vscode.Uri }; // The icon to display in the tree view

	/**
	 * The children of this node.
	 */
	children?: TreeNode[];

	/**
	 * The context value used for vscode.TreeItem.contextValue, which allows for item-specific commands. Context taken from nodeType if null.
	 */
	treeContext?: TreeContextSpecifier;

	/**
	 * If the node refers to a value stored in some object, this will be a reference to the containing object.
	 */
	optionId?: ArtifactOptionId;
	checked?: boolean;

	/**
	 * A reference to the tree that owns this node. Automatically set by the tree.
	 */
	tree?: TreeProvider<TreeNode>;

	/**
	 * The tooltip to display for this node.
	 */
	tooltip?: string;

	description?: string;

	disabled?: boolean;

}

export class TreeItem extends vscode.TreeItem {
    constructor(node: TreeNode) {
		// Initialize the base class with default empty values. These will be overwritten further down.
		super('', vscode.TreeItemCollapsibleState.None);

		const { label, nodeType, treeContext, iconPath } = node;

		this.label = label;
		this.iconPath = iconPath;
		this.tooltip = node.tooltip;
		this.description = node.description;
		this.contextValue = treeContext ?? nodeType;

		if (nodeType === 'subtree') {
			this.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
		}
		else if (nodeType === 'checkbox' && !node.disabled) {
			this.checkboxState = node.checked
				? vscode.TreeItemCheckboxState.Checked
				: vscode.TreeItemCheckboxState.Unchecked;
        }
		else if (node.disabled) {
			this.contextValue = 'disabled';
			this.iconPath ??= new vscode.ThemeIcon('circle-slash');
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
