import path from 'node:path';
import { commands, Disposable, StatusBarAlignment, window, type StatusBarItem } from 'vscode';
import type { ActiveArtifact } from './active-artifact.js';
import type { ArtifactRegistryDocument } from './artifact-document-registry.js';

/** The context key that enables the commands that act on the active artifact. */
export const activeArtifactContextKey = 'coglens.activeArtifact';

/** Shows the state of the active artifact, and opens its actions on a click. */
export class ArtifactStatusBar implements Disposable {
	private readonly item: StatusBarItem = window.createStatusBarItem(StatusBarAlignment.Right, 1000);
	private readonly subscription: Disposable;
	private hasActiveArtifact?: boolean;

	constructor(private readonly active: ActiveArtifact) {
		this.item.name = 'Cogitator Lens Artifact Status';
		this.item.command = 'coglens.ShowArtifactStatus';
		this.subscription = active.onDidChange(() => this.refresh());
		this.refresh();
	}

	dispose(): void {
		this.subscription.dispose();
		this.item.dispose();
	}

	private refresh(): void {
		const document = this.active.document;
		this.setContext(document !== undefined);
		if (!document) {
			this.item.hide();
			return;
		}
		this.item.text = statusText(document);
		this.item.tooltip = statusTooltip(document);
		this.item.show();
	}

	private setContext(hasActiveArtifact: boolean): void {
		if (this.hasActiveArtifact === hasActiveArtifact) {
			return;
		}
		this.hasActiveArtifact = hasActiveArtifact;
		void commands.executeCommand('setContext', activeArtifactContextKey, hasActiveArtifact);
	}
}

function statusText({ handler }: ArtifactRegistryDocument): string {
	const { status } = handler;
	switch (status.state) {
		case 'compiling':
			return '$(sync~spin) Compiling';
		case 'stale':
			// A refresh request during a compile makes the state stale, but the compile still runs.
			return handler.generating ? '$(sync~spin) Compiling' : '$(history) Stale';
		case 'cancelled':
			return '$(circle-slash) Cancelled';
		case 'failed':
			return status.truncated ? '$(warning) Truncated' : '$(error) Failed';
		case 'successful':
			return status.truncated ? '$(warning) Truncated' : '$(check) Ready';
	}
}

function statusTooltip({ identity, handler }: ArtifactRegistryDocument): string {
	const { status } = handler;
	return [
		`${identity.artifactLabel} · ${path.basename(identity.sourceLabel)}`,
		`${identity.variantLabel} · ${identity.toolchainLabel}`,
		status.state === 'failed' ? status.error.message : `State: ${status.state}`,
		'Click for artifact actions',
	].join('\n');
}
