import vscode from 'vscode';
import {
	artifactDefinitions,
} from '../artifacts/artifact-definitions.js';
import {
	buildArtifactDetails,
	type ArtifactDetailsItem,
} from '../artifacts/artifact-details.js';
import {
	AsmProvider,
	type ArtifactDocumentSnapshot,
} from '../asm-document/asm-provider.js';
import { TreeNode, TreeProvider } from './treedata.js';

export class ArtifactDetailsTreeNode extends TreeNode {
	readonly id: string;
	declare children?: ArtifactDetailsTreeNode[];

	constructor(item: ArtifactDetailsItem) {
		super();
		this.id = item.id;
		this.label = item.label;
		this.description = item.value;
		this.tooltip = item.value !== undefined ? `${item.label}: ${item.value}` : item.label;
		this.copyText = item.copyText;
		this.children = item.children?.map(child => new ArtifactDetailsTreeNode(child));
		this.nodeType = this.children ? 'subtree' : 'text';
		this.treeContext = item.copyText !== undefined ? 'text' : undefined;
		this.iconPath = this.children ? groupIcon(item.id) : undefined;
	}
}

export class ArtifactDetailsTreeProvider extends TreeProvider<ArtifactDetailsTreeNode> {
	private activeDocumentUri?: string;
	private snapshot?: ArtifactDocumentSnapshot;

	constructor(private readonly artifacts: AsmProvider) {
		super();
	}

	setActiveDocument(uri: vscode.Uri | undefined): void {
		if (!uri || uri.scheme !== AsmProvider.scheme) {
			this.activeDocumentUri = undefined;
			this.snapshot = undefined;
			this.refresh();
			return;
		}
		this.activeDocumentUri = uri.toString();
		this.snapshot = this.artifacts.getArtifactDocumentState(uri);
		this.refresh();
	}

	setActiveSnapshot(snapshot: ArtifactDocumentSnapshot | undefined): void {
		this.activeDocumentUri = snapshot?.identity.documentUri;
		this.snapshot = snapshot;
		this.refresh();
	}

	acceptArtifactState(snapshot: ArtifactDocumentSnapshot): void {
		if (snapshot.identity.documentUri !== this.activeDocumentUri) {
			return;
		}
		this.snapshot = snapshot;
		this.refresh();
	}

	getChildren(element?: ArtifactDetailsTreeNode): ArtifactDetailsTreeNode[] {
		if (element) {
			return element.children ?? [];
		}
		if (!this.activeDocumentUri) {
			return [emptyState('Open a Cogitator Lens artifact to see its details.')];
		}
		if (!this.snapshot) {
			return [emptyState('Artifact details are not available yet.')];
		}
		const definition = artifactDefinitions[this.snapshot.identity.artifactKind];
		const metricLabels = 'metricLabels' in definition
			? definition.metricLabels
			: undefined;
		return buildArtifactDetails(this.snapshot, metricLabels)
			.map(item => new ArtifactDetailsTreeNode(item));
	}
}

function emptyState(label: string): ArtifactDetailsTreeNode {
	const node = new ArtifactDetailsTreeNode({ id: 'empty', label });
	node.disabled = true;
	return node;
}

function groupIcon(id: string): vscode.ThemeIcon {
	const icon = {
		artifact: 'symbol-file',
		status: 'pulse',
		invocation: 'terminal',
		environment: 'symbol-variable',
		metrics: 'graph',
		arguments: 'list-ordered',
	}[id] ?? 'list-tree';
	return new vscode.ThemeIcon(icon);
}
