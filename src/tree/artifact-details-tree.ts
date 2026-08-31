import vscode from 'vscode';
import {
	artifactDefinitions,
} from '../artifacts/core/artifact-definitions.js';
import {
	buildArtifactDetails,
	type ArtifactDetailsItem,
} from '../artifacts/ui/artifact-details.js';
import {
	ArtifactDocumentProvider,
} from '../artifact-document/artifact-document-provider.js';
import type { ArtifactDocumentSnapshot } from '../artifact-document/artifact-identity.js';
import { TreeNode, TreeProvider } from './treedata.js';
import { messageNode } from './tree-helpers.js';

export interface ArtifactDetailsTreeNode extends TreeNode {
}

function buildArtifactDetailsTreeNode(item: ArtifactDetailsItem): ArtifactDetailsTreeNode {
	const children = item.children?.map(buildArtifactDetailsTreeNode);
	return {
		id: item.id,
		label: item.label,
		description: item.value,
		tooltip: item.value !== undefined ? `${item.label}: ${item.value}` : item.label,
		copyText: item.copyText,
		children,
		nodeType: children ? 'subtree' : 'text',
		treeContext: item.copyText !== undefined ? 'text' : undefined,
		iconPath: children ? groupIcon(item.id) : undefined,
	};
}

export class ArtifactDetailsTreeProvider extends TreeProvider<ArtifactDetailsTreeNode> {
	private activeDocumentUri?: string;
	private snapshot?: ArtifactDocumentSnapshot;

	constructor(private readonly artifacts: ArtifactDocumentProvider) {
		super();
	}

	setActiveDocument(uri: vscode.Uri | undefined): void {
		if (!uri || uri.scheme !== ArtifactDocumentProvider.scheme) {
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
		return buildArtifactDetails(this.snapshot, definition.metricLabels)
			.map(buildArtifactDetailsTreeNode);
	}
}

function emptyState(label: string): ArtifactDetailsTreeNode {
	return { id: 'empty', ...messageNode(label), disabled: true };
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
