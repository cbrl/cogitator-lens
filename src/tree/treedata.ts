import assert from "assert";
import vscode from "vscode";

export type TreeItemSpecifier = 'checkbox' | 'subtree' | 'text';
export type TreeContextSpecifier = 'array' | 'editText' | 'element' | 'filters' | 'instance' | 'pickFile' | 'text';

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
	objectRef?: any;

	/**
	 * If the node refers to a value stored in some object, this will be the name or index of the attribute within the object.
	 */
	attr?: string | number;

	/**
	 * A reference to the tree that owns this node. Automatically set by the tree.
	 */
	tree?: TreeProvider<TreeNode>;

	/**
	 * The tooltip to display for this node.
	 */
	tooltip?: string;

	/**
	 * Creates a context string representing multiple context types. This is used for nodes that can be interacted with in multiple ways.
	 * @param args The arguments to join together.
	 * @returns The joined context string.
	 */
	static multiContext(...args: string[]): string {
		return args.join('&');
	}

	/**
	 * Populates the children of a node representing an array of values. Each child node will
	 * represent an element in the array, and will be labeled with its index and value.
	 *
	 * @param node The node to populate with children.
	 * @param array The array of values to use as children.
	 * @param options Additional options for the child nodes.
	 */
	static populateArrayNodeChildren(node: TreeNode, array: any[], options: { nodeType: TreeItemSpecifier, [key: string]: any }): void {
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

export class TreeItem extends vscode.TreeItem {
    constructor(node: TreeNode) {
		// Initialize the base class with default empty values. These will be overwritten further down.
		super('', vscode.TreeItemCollapsibleState.None);

        const { label, nodeType, treeContext, iconPath, objectRef, attr } = node;

		this.label = label;
		this.iconPath = iconPath;
		this.tooltip = node.tooltip;
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
