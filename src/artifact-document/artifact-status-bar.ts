import path from 'node:path';
import {
	commands,
	Disposable,
	StatusBarAlignment,
	window,
	workspace,
	type StatusBarItem,
	type TextDocument,
	type Uri,
} from 'vscode';
import { sourceUriComparisonKey } from '../file-identity.js';
import type { ActiveArtifact } from './active-artifact.js';
import { unsavedSourceNote } from './artifact-decorator.js';
import type { ArtifactRegistryDocument } from './artifact-document-registry.js';
import { showsSavedFileOnly } from './artifact-generator.js';

/** The context key that enables the commands that act on the active artifact. */
export const activeArtifactContextKey = 'coglens.activeArtifact';

/** Shows the state of the active artifact, and opens its actions on a click. */
export class ArtifactStatusBar implements Disposable {
	private readonly item: StatusBarItem = window.createStatusBarItem(StatusBarAlignment.Right, 1000);
	private readonly subscription: Disposable;
	private hasActiveArtifact?: boolean;
	/** Whether the source of the shown artifact had unsaved changes at the last refresh. */
	private shownUnsaved = false;

	constructor(
		private readonly active: ActiveArtifact,
		/** Whether the open artifacts of a source compile its unsaved text. */
		private readonly compileOnType: (source: Uri) => boolean = () => false,
	) {
		this.item.name = 'Cogitator Lens Artifact Status';
		this.item.command = 'coglens.ShowArtifactStatus';
		// The dirty state of the source changes the text, so a change refreshes only when it
		// changes that state. A keystroke in a source that is already unsaved does nothing.
		const sourceChanged = (source: TextDocument): void => {
			const document = this.active.document;
			if (document && isSourceOf(document, source) && this.sourceIsUnsaved(document) !== this.shownUnsaved) {
				this.refresh();
			}
		};
		this.subscription = Disposable.from(
			active.onDidChange(() => this.refresh()),
			workspace.onDidChangeTextDocument((event) => sourceChanged(event.document)),
			workspace.onDidSaveTextDocument(sourceChanged),
			workspace.onDidCloseTextDocument(sourceChanged),
		);
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
			this.shownUnsaved = false;
			this.item.hide();
			return;
		}
		// The note at the end of the first artifact line is often past the right edge, so the
		// status bar also shows the unsaved state.
		this.shownUnsaved = this.sourceIsUnsaved(document);
		this.item.text = this.shownUnsaved ? `${statusText(document)} · Unsaved source` : statusText(document);
		this.item.tooltip = statusTooltip(document, this.shownUnsaved);
		this.item.show();
	}

	/**
	 * Whether the source has unsaved edits that the artifact does not show. With
	 * `coglens.compileOnType`, a compile of the unsaved text follows each pause, so the edits are not
	 * unsaved in this sense, unless the toolchain reads only the saved file.
	 */
	private sourceIsUnsaved(document: ArtifactRegistryDocument): boolean {
		return (
			showsSavedFileOnly(document.handler.status.sourceText, this.compileOnType(document.parsed.source)) &&
			workspace.textDocuments.some((source) => !source.isClosed && source.isDirty && isSourceOf(document, source))
		);
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

function statusTooltip({ identity, handler }: ArtifactRegistryDocument, unsaved: boolean): string {
	const { status } = handler;
	return [
		`${identity.artifactLabel} · ${path.basename(identity.sourceLabel)}`,
		`${identity.variantLabel} · ${identity.toolchainLabel}`,
		status.state === 'failed' ? status.error.message : `State: ${status.state}`,
		...(unsaved ? [unsavedSourceNote(status.sourceText?.savedFileReason)] : []),
		'Click for artifact actions',
	].join('\n');
}

function isSourceOf(document: ArtifactRegistryDocument, source: TextDocument): boolean {
	return (
		source.uri.scheme === 'file' &&
		sourceUriComparisonKey(source.uri) === sourceUriComparisonKey(document.parsed.source)
	);
}
