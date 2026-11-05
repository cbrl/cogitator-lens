import {
	CancellationError,
	CancellationToken,
	Disposable,
	Event,
	EventEmitter,
	TabInputText,
	TabInputTextDiff,
	TextDocument,
	TextDocumentContentProvider,
	Uri,
	window,
	workspace,
	type Tab,
	type TabChangeEvent,
} from 'vscode';
import path from 'path';
import { CompilationService } from '../compilation/index.js';
import { failureDetails } from '../compilation/compilation-service.js';
import type { ConfigurationService } from '../services/configuration-service.js';
import { CompilationError, type RenderedTextArtifact } from '../types/index.js';
import { artifactScheme } from './artifact-uri.js';
import { ArtifactDecorator } from './artifact-decorator.js';
import {
	ArtifactDocumentRegistry,
	type ArtifactRegistryDocument,
	type ArtifactView,
} from './artifact-document-registry.js';
import { uriComparisonKey } from '../file-identity.js';
import type { ArtifactDocumentSnapshot } from './artifact-identity.js';
import { emptyArtifactText } from '../artifacts/ui/empty-artifact.js';

/** How long the first compile of a document runs before its tab opens with a placeholder. */
const placeholderDelayMs = 150;

/** The text of an artifact document. A notice, such as the placeholder, stands in for the artifact. */
interface DocumentContent {
	readonly text: string;
	readonly notice: boolean;
}

/** The state of one open text artifact document. */
class TextArtifactView implements ArtifactView {
	/** The artifact text that the editor shows now. It is never a notice. A cancelled refresh keeps it. */
	text?: string;
	/** Whether the editor shows a notice in place of the artifact. */
	showsNotice = false;
	/** A result that arrived after the placeholder. The next content request returns it once. */
	pendingContent?: DocumentContent;
	/** Counts content requests, so a late result applies only when no newer request started. */
	requests = 0;
	private readonly decorator: ArtifactDecorator;

	constructor(
		readonly document: ArtifactRegistryDocument,
		createDecorator: (view: TextArtifactView) => ArtifactDecorator,
		readonly refresh: () => void,
		readonly onStatus: () => void,
	) {
		this.decorator = createDecorator(this);
	}

	/** Records the content that the editor gets, and returns its text. */
	show(content: DocumentContent): string {
		this.showsNotice = content.notice;
		if (!content.notice) {
			this.text = content.text;
		}
		return content.text;
	}

	dispose(): void {
		this.decorator.dispose();
	}
}

export class ArtifactDocumentProvider implements TextDocumentContentProvider, Disposable {
	static readonly scheme = artifactScheme;

	private readonly changeEmitter = new EventEmitter<Uri>();
	private readonly subscriptions: Disposable[];

	constructor(
		private readonly compilationService: CompilationService,
		private readonly configuration: ConfigurationService,
		private readonly registry: ArtifactDocumentRegistry,
	) {
		this.subscriptions = [
			workspace.onDidCloseTextDocument((document) => this.onCloseTextDocument(document)),
			workspace.onDidOpenTextDocument((document) => this.onOpenTextDocument(document)),
			window.tabGroups.onDidChangeTabs((event) => this.onDidChangeTabs(event)),
			this.changeEmitter,
		];
	}

	// Implements TextDocumentContentProvider.provideTextDocumentContent. VS Code calls it when a document
	// opens and after each onDidChange(uri). The registry fires onDidChange when the source changes.
	async provideTextDocumentContent(uri: Uri, token: CancellationToken): Promise<string> {
		const view = this.registry.view(uri, TextArtifactView) ?? this.openView(uri);
		const pending = view.pendingContent;
		if (pending) {
			// Do not compile again. This request only collects the result of the earlier one.
			view.pendingContent = undefined;
			return view.show(pending);
		}

		const request = ++view.requests;
		const generated = this.generateContent(view, token);
		if (view.text !== undefined) {
			return view.show(await generated);
		}
		// VS Code opens no tab before the document has text. A slow first compile shows a placeholder
		// at once, and its result follows as a change. A fast compile, such as a cache hit, shows no placeholder.
		const early = await settledWithin(generated, placeholderDelayMs);
		if (early) {
			return view.show(early);
		}
		void generated.then((content) => {
			if (view.requests === request && this.registry.view(uri, TextArtifactView) === view) {
				view.pendingContent = content;
				this.changeEmitter.fire(uri);
			}
		});
		return view.show({ text: placeholderText(view.document), notice: true });
	}

	get onDidChange(): Event<Uri> {
		return this.changeEmitter.event;
	}

	get onDidChangeArtifactState(): Event<ArtifactDocumentSnapshot> {
		return this.registry.onDidChangeArtifactState;
	}

	getRenderedArtifact(uri: Uri): RenderedTextArtifact | undefined {
		const artifact = this.registry.view(uri, TextArtifactView)?.document.handler.status.artifact;
		return artifact?.presentation === 'text' ? artifact : undefined;
	}

	/** Returns already-known state only; activating a details view never compiles. */
	getArtifactDocumentState(uri: Uri): ArtifactDocumentSnapshot | undefined {
		return this.registry.view(uri, TextArtifactView)?.document.snapshot;
	}

	requestRefresh(artifactUri: Uri): void {
		this.registry.requestRefresh(artifactUri);
	}

	dispose(): void {
		this.subscriptions.forEach((subscription) => subscription.dispose());
		for (const view of this.registry.views(TextArtifactView)) {
			this.registry.unregister(view.document.uri);
		}
	}

	private generateContent(view: TextArtifactView, token: CancellationToken): Promise<DocumentContent> {
		return view.document.handler
			.update(token)
			.then((artifact): DocumentContent => {
				if (artifact.presentation !== 'text') {
					throw new CompilationError('Graph artifacts must be opened in the control-flow graph view.');
				}
				return { text: artifactText(artifact, view.document), notice: false };
			})
			.catch((error: unknown): DocumentContent => {
				if (error instanceof CancellationError || token.isCancellationRequested) {
					return view.text === undefined
						? { text: cancelledText(view.document), notice: true }
						: { text: view.text, notice: false };
				}

				// Keep the listing of the last successful compile. Its decorations and navigation still
				// describe it, and the decorator reports the failure on the first line.
				const retained = view.document.handler.status.artifact;
				if (retained?.presentation === 'text') {
					return { text: artifactText(retained, view.document), notice: false };
				}
				const details = failureDetails(error);
				return {
					text:
						error instanceof CompilationError && error.truncated
							? `[truncated; process output limit exceeded]\n\n${details}`
							: details,
					notice: false,
				};
			});
	}

	private openView(uri: Uri): TextArtifactView {
		return this.registry.open(
			uri,
			(document) =>
				new TextArtifactView(
					document,
					(view) =>
						new ArtifactDecorator(
							document.handler.sourceUri,
							document.handler.artifactUri,
							document.handler.onDidChange,
							this.configuration,
							(kind) => this.compilationService.getArtifactOptions(kind),
							this.compilationService.onArtifactDecorationsChanged,
							() => view.showsNotice,
						),
					() => this.changeEmitter.fire(document.uri),
					() => {},
				),
		);
	}

	private onOpenTextDocument(document: TextDocument): void {
		// VS Code ignores a change to a document that is not open yet. A result that arrived before the
		// document opened is announced again.
		if (this.registry.view(document.uri, TextArtifactView)?.pendingContent) {
			this.changeEmitter.fire(document.uri);
		}
	}

	private onCloseTextDocument(document: TextDocument): void {
		// Guard against a race: if the user reopens the same document quickly, the delayed close event of
		// the old document would destroy the new view. Only clean up if no tab still shows this document.
		if (this.registry.view(document.uri, TextArtifactView) && !shownInTab(document.uri)) {
			this.registry.unregister(document.uri);
		}
	}

	private onDidChangeTabs(event: TabChangeEvent): void {
		// A document can stay open for a while after its last tab closes. Stop its compiles at once.
		for (const uri of event.closed.flatMap(tabArtifactUris)) {
			if (this.registry.view(uri, TextArtifactView) && !shownInTab(uri)) {
				this.registry.unregister(uri);
			}
		}
		// A reopened tab can reuse that document without a content request. A change gives it a new view.
		for (const uri of event.opened.flatMap(tabArtifactUris)) {
			if (
				!this.registry.document(uri) &&
				workspace.textDocuments.some((document) => uriComparisonKey(document.uri) === uriComparisonKey(uri))
			) {
				this.changeEmitter.fire(uri);
			}
		}
	}
}

export { getArtifactUri, parseArtifactUri } from './artifact-uri.js';

function artifactText(artifact: RenderedTextArtifact, document: ArtifactRegistryDocument): string {
	if (!artifact.lines.some((line) => line.text.trim())) {
		return emptyArtifactText(artifact, document.identity);
	}
	return artifact.lines.map((line) => line.text).join('\n');
}

function placeholderText({ parsed, identity }: ArtifactRegistryDocument): string {
	const toolchain = identity.toolchainKind === 'unknown' ? '' : ` with ${identity.toolchainLabel}`;
	return `Compiling ${path.basename(parsed.source.fsPath)}${toolchain}…`;
}

function cancelledText({ parsed }: ArtifactRegistryDocument): string {
	return `Generation was cancelled. Run "Refresh Artifact" to compile ${path.basename(parsed.source.fsPath)} again.`;
}

/** The artifact documents that a tab shows. A diff tab shows two. */
function tabArtifactUris(tab: Tab): Uri[] {
	const input = tab.input;
	const uris =
		input instanceof TabInputText
			? [input.uri]
			: input instanceof TabInputTextDiff
				? [input.original, input.modified]
				: [];
	return uris.filter((uri) => uri.scheme === artifactScheme);
}

function shownInTab(uri: Uri): boolean {
	const key = uriComparisonKey(uri);
	return window.tabGroups.all.some((group) =>
		group.tabs.some((tab) => tabArtifactUris(tab).some((candidate) => uriComparisonKey(candidate) === key)),
	);
}

/** The value of a promise that settles within the time, or nothing. */
function settledWithin<T>(promise: Promise<T>, milliseconds: number): Promise<T | undefined> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<undefined>((resolve) => {
		timer = setTimeout(() => resolve(undefined), milliseconds);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
