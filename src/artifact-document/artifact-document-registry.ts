import path from 'node:path';
import {
	Disposable,
	Event,
	EventEmitter,
	RelativePattern,
	Uri,
	workspace,
	type TextDocument,
	type TextDocumentChangeEvent,
} from 'vscode';
import { artifactDefinitions } from '../artifacts/core/artifact-definitions.js';
import type { CompilationService } from '../compilation/index.js';
import type { ConfigurationService } from '../services/configuration-service.js';
import { getArtifactOutputChoices } from '../toolchains/toolchain-artifacts.js';
import type { CompilationVariant, ToolchainProfile } from '../types/index.js';
import { CompilationError } from '../types/index.js';
import { sourceUriComparisonKey, uriComparisonKey } from '../file-identity.js';
import { parseArtifactUri, type ArtifactUriIdentity } from './artifact-uri.js';
import { ArtifactGenerator, type ArtifactStatus, type SourceDocumentState } from './artifact-generator.js';
import type { ArtifactDocumentIdentity, ArtifactDocumentSnapshot } from './artifact-identity.js';
import { ArtifactProblems } from './artifact-problems.js';
import { ArtifactArguments } from './artifact-arguments.js';

export interface ArtifactRegistryDocument {
	readonly uri: Uri;
	readonly parsed: ArtifactUriIdentity;
	readonly identity: ArtifactDocumentIdentity;
	readonly handler: ArtifactGenerator;
	/** The identity and the current status, as the details view shows them. */
	readonly snapshot: ArtifactDocumentSnapshot;
}

/** The consumer of one artifact document, such as a text editor or a graph panel. */
export interface ArtifactView {
	/** Regenerates the artifact after the registry marks it stale. */
	refresh(): void;
	onStatus(status: ArtifactStatus): void;
	dispose(): void;
}

type ViewClass<V extends ArtifactView> = abstract new (...args: never[]) => V;

interface RegisteredArtifactDocument extends ArtifactRegistryDocument {
	/** The variant the identity describes, or nothing when it is not available. */
	readonly variant: CompilationVariant | undefined;
	/** The comparison key of the source. */
	readonly sourceKey: string;
	view?: ArtifactView;
	subscriptions: Disposable;
	pendingRefresh?: ReturnType<typeof setTimeout>;
}

/** How long typing must pause before the artifacts of a source compile its unsaved text. */
export const compileOnTypeDelayMs = 500;

/** Describes an artifact document. The variant is missing when it is no longer available. */
export function buildArtifactIdentity(
	uri: Uri,
	parsed: ArtifactUriIdentity,
	variant: CompilationVariant | undefined,
	profile: ToolchainProfile | undefined,
): ArtifactDocumentIdentity {
	const artifactOutput =
		parsed.artifactOutputId && profile
			? getArtifactOutputChoices(profile, parsed.artifactKind).find(
					(output) => output.id === parsed.artifactOutputId,
				)
			: undefined;
	const artifactLabel =
		artifactOutput?.label ?? parsed.artifactOutputId ?? artifactDefinitions[parsed.artifactKind].label;
	return {
		documentUri: uri.toString(),
		sourceUri: parsed.source.toString(),
		sourceLabel: parsed.source.fsPath,
		artifactKind: parsed.artifactKind,
		artifactLabel,
		...(parsed.artifactOutputId ? { artifactOutputId: parsed.artifactOutputId } : {}),
		...(parsed.functionFilter === undefined ? {} : { functionFilter: parsed.functionFilter }),
		presetId: parsed.presetId,
		variantId: parsed.variantId,
		variantLabel: variant?.displayLabel ?? 'Unavailable variant',
		toolchainId: profile?.id ?? variant?.toolchainProfileId ?? 'unknown',
		toolchainLabel: profile?.displayName ?? variant?.toolchainProfileId ?? 'Unknown toolchain',
		toolchainKind: profile?.kind ?? 'unknown',
	};
}

/** Shared lifecycle, invalidation, and identity owner for text documents and graph panels. */
export class ArtifactDocumentRegistry implements Disposable {
	private readonly documents = new Map<string, RegisteredArtifactDocument>();
	private readonly stateEmitter = new EventEmitter<ArtifactDocumentSnapshot>();
	private readonly documentsEmitter = new EventEmitter<void>();
	private readonly problems = new ArtifactProblems();
	private readonly subscriptions: Disposable;
	/** The last version of each open source document that had the text of the saved file, by source key. */
	private readonly savedVersions = new Map<string, number>();
	/** The pending compile of the unsaved text of each source, by source key. */
	private readonly typingTimers = new Map<string, ReturnType<typeof setTimeout>>();
	/**
	 * Advanced by every change that can alter a variant or a toolchain. Resolving a variant
	 * rebuilds the fallback variants, so each document resolves its own once per change.
	 */
	private identityGeneration = 0;

	readonly onDidChangeArtifactState: Event<ArtifactDocumentSnapshot> = this.stateEmitter.event;
	/** Fires when a document opens or closes. */
	readonly onDidChangeDocuments: Event<void> = this.documentsEmitter.event;

	constructor(
		private readonly compilationService: CompilationService,
		private readonly configuration: ConfigurationService,
		/** The arguments that the user edited for each document. */
		readonly editedArguments: ArtifactArguments = new ArtifactArguments(),
	) {
		for (const document of workspace.textDocuments) {
			this.recordSavedVersion(document);
		}
		this.subscriptions = Disposable.from(
			workspace.onDidOpenTextDocument((document) => this.recordSavedVersion(document)),
			workspace.onDidSaveTextDocument((document) => this.recordSavedVersion(document)),
			workspace.onDidChangeTextDocument((event) => this.onSourceTextChanged(event)),
			workspace.onDidCloseTextDocument((document) => this.onSourceClosed(document)),
			editedArguments.onDidChange((uri) => this.requestRefresh(uri)),
			compilationService.onVariantsChanged((sources) => {
				this.identityGeneration++;
				const changed = new Set(sources.map(sourceUriComparisonKey));
				for (const document of this.documents.values()) {
					if (changed.has(sourceUriComparisonKey(document.parsed.source))) {
						this.requestRefresh(document.uri);
					}
				}
			}),
			// A folder variant, such as a C/C++ configuration, can give any source a new fallback variant.
			compilationService.onFallbackVariantsChanged(() => {
				this.identityGeneration++;
				this.refreshAll();
			}),
			compilationService.onArtifactOptionsChanged((kind) => {
				for (const document of this.documents.values()) {
					if (document.parsed.artifactKind === kind) {
						this.requestRefresh(document.uri);
					}
				}
			}),
			// Other settings reach open artifacts through variant, toolchain, and option events.
			configuration.onDidChange((change) => {
				this.identityGeneration++;
				// The listing line limit applies when the parser reads the raw output. A refresh renders
				// the cached raw output again, so it starts no compile.
				if (
					change.affects('defaultInvocation') ||
					change.affects('artifactPresets') ||
					change.affects('listingLineLimit')
				) {
					this.refreshAll();
				} else if (change.affects('compileOnType')) {
					// A source with unsaved text now compiles the other text.
					for (const document of this.documents.values()) {
						if (openSourceDocument(document.parsed.source, document.sourceKey)?.isDirty) {
							this.requestRefresh(document.uri);
						}
					}
				}
			}),
			workspace.onDidChangeWorkspaceFolders(() => this.identityGeneration++),
			// A document is refreshed when its toolchain changed, or when its variant may now resolve
			// differently: one not found yet, or the default invocation, which names its toolchain.
			compilationService.toolchainRegistry.onDidChange(({ changed }) => {
				this.identityGeneration++;
				for (const document of this.documents.values()) {
					const variant = document.variant;
					if (!variant || isDefaultInvocation(variant) || changed.has(variant.toolchainProfileId)) {
						this.requestRefresh(document.uri);
					}
				}
			}),
			this.stateEmitter,
			this.documentsEmitter,
			this.problems,
		);
	}

	/** Returns an open document. */
	document(uri: Uri): ArtifactRegistryDocument | undefined {
		return this.documents.get(uriComparisonKey(uri));
	}

	/** Returns the open documents of a source, in the order that they opened. */
	documentsOf(source: Uri): ArtifactRegistryDocument[] {
		const key = sourceUriComparisonKey(source);
		return [...this.documents.values()].filter(
			(document) => sourceUriComparisonKey(document.parsed.source) === key,
		);
	}

	/** Returns the view of an open document when the view has the given class. */
	view<V extends ArtifactView>(uri: Uri, type: ViewClass<V>): V | undefined {
		const view = this.documents.get(uriComparisonKey(uri))?.view;
		return view instanceof type ? view : undefined;
	}

	/** Returns the views of the given class for every open document. */
	views<V extends ArtifactView>(type: ViewClass<V>): V[] {
		return [...this.documents.values()].flatMap((document) =>
			document.view instanceof type ? [document.view] : [],
		);
	}

	/** Opens a document and attaches the view that consumes it. Each document has one view. */
	open<V extends ArtifactView>(uri: Uri, createView: (document: ArtifactRegistryDocument) => V): V {
		const key = uriComparisonKey(uri);
		if (this.documents.has(key)) {
			throw new Error(`An artifact document is already open: ${uri.toString()}`);
		}

		const parsed = parseArtifactUri(uri);
		if (!parsed) {
			throw new CompilationError(`Invalid artifact document URI: ${uri.toString()}`);
		}
		// The generator resolves the variant for each update, so a document whose variant is not
		// known yet, such as a restored tab, opens and recovers when its provider reports it.
		const sourceKey = sourceUriComparisonKey(parsed.source);
		const handler = new ArtifactGenerator(
			parsed.source,
			uri,
			parsed.variantId,
			parsed.artifactKind,
			parsed.presetId,
			this.compilationService,
			parsed.artifactOutputId,
			{
				extraArguments: () => this.editedArguments.get(uri),
				view: parsed.view,
				...(parsed.functionFilter === undefined ? {} : { functionFilter: parsed.functionFilter }),
				sourceDocument: () => this.sourceDocumentState(parsed.source, sourceKey),
			},
		);
		const watcher = workspace.createFileSystemWatcher(
			new RelativePattern(Uri.file(path.dirname(parsed.source.fsPath)), path.basename(parsed.source.fsPath)),
		);
		let resolved:
			| { generation: number; variant: CompilationVariant | undefined; identity: ArtifactDocumentIdentity }
			| undefined;
		const resolve = (): NonNullable<typeof resolved> => {
			if (resolved?.generation !== this.identityGeneration) {
				const variant = this.compilationService.findVariant(parsed.source, parsed.variantId);
				const profile = variant
					? this.compilationService.toolchainRegistry.getToolchainById(variant.toolchainProfileId)?.profile
					: undefined;
				resolved = {
					generation: this.identityGeneration,
					variant,
					identity: buildArtifactIdentity(uri, parsed, variant, profile),
				};
			}
			return resolved;
		};
		const document: RegisteredArtifactDocument = {
			uri,
			parsed,
			get identity() {
				return resolve().identity;
			},
			get variant() {
				return resolve().variant;
			},
			sourceKey,
			handler,
			get snapshot() {
				return { identity: this.identity, status: this.handler.status };
			},
			subscriptions: Disposable.from(),
		};
		const view = createView(document);
		document.view = view;
		document.subscriptions = Disposable.from(
			watcher,
			watcher.onDidChange(() => this.requestRefresh(uri)),
			handler.onDidChange((status) => {
				this.problems.accept(key, status);
				view.onStatus(status);
				this.stateEmitter.fire(document.snapshot);
			}),
		);
		this.documents.set(key, document);
		this.stateEmitter.fire(document.snapshot);
		this.documentsEmitter.fire();
		return view;
	}

	private refreshAll(): void {
		for (const document of this.documents.values()) {
			this.requestRefresh(document.uri);
		}
	}

	requestRefresh(uri: Uri): void {
		const document = this.documents.get(uriComparisonKey(uri));
		if (!document) {
			return;
		}
		document.handler.markStale();
		if (document.pendingRefresh) {
			clearTimeout(document.pendingRefresh);
		}
		document.pendingRefresh = setTimeout(() => {
			document.pendingRefresh = undefined;
			document.view?.refresh();
		}, 50);
	}

	unregister(uri: Uri): void {
		const key = uriComparisonKey(uri);
		const document = this.documents.get(key);
		if (!document) {
			return;
		}
		this.documents.delete(key);
		if (document.pendingRefresh) {
			clearTimeout(document.pendingRefresh);
		}
		document.subscriptions.dispose();
		document.view?.dispose();
		document.handler.dispose();
		this.problems.delete(key);
		this.documentsEmitter.fire();
	}

	dispose(): void {
		for (const document of [...this.documents.values()]) {
			this.unregister(document.uri);
		}
		this.typingTimers.forEach((timer) => clearTimeout(timer));
		this.typingTimers.clear();
		this.subscriptions.dispose();
	}

	/**
	 * The open document of a source when a compile starts. With `coglens.compileOnType`, the compile
	 * reads its unsaved text.
	 */
	private sourceDocumentState(source: Uri, sourceKey: string): SourceDocumentState | undefined {
		const document = openSourceDocument(source, sourceKey);
		if (!document) {
			return undefined;
		}
		const unsaved = document.isDirty && this.configuration.getCompileOnType(source);
		return {
			version: document.version,
			savedVersion: document.isDirty ? this.savedVersions.get(sourceKey) : document.version,
			...(unsaved ? { unsavedText: document.getText() } : {}),
		};
	}

	/** Records the version of a document while it has the text of the saved file. */
	private recordSavedVersion(document: TextDocument): void {
		if (document.uri.scheme === 'file' && !document.isDirty) {
			this.savedVersions.set(sourceUriComparisonKey(document.uri), document.version);
		}
	}

	/**
	 * Compiles the unsaved text of a source when typing pauses. The compile of earlier text stops at
	 * once, because its result is of no use. A change that undoes each edit compiles the saved file.
	 */
	private onSourceTextChanged(event: TextDocumentChangeEvent): void {
		const source = event.document;
		// A change of the dirty state alone has no content changes.
		if (source.uri.scheme !== 'file' || event.contentChanges.length === 0) {
			return;
		}
		this.recordSavedVersion(source);
		if (this.documents.size === 0) {
			return;
		}
		const sourceKey = sourceUriComparisonKey(source.uri);
		const documents = [...this.documents.values()].filter((document) => document.sourceKey === sourceKey);
		if (documents.length === 0 || !this.configuration.getCompileOnType(source.uri)) {
			return;
		}
		clearTimeout(this.typingTimers.get(sourceKey));
		this.typingTimers.set(
			sourceKey,
			setTimeout(() => {
				this.typingTimers.delete(sourceKey);
				for (const document of this.documents.values()) {
					if (document.sourceKey === sourceKey) {
						this.refreshNow(document, { cancel: true });
					}
				}
			}, compileOnTypeDelayMs),
		);
	}

	/**
	 * An artifact of unsaved text shows text that no longer exists after the source closes without a
	 * save, so it compiles the saved file.
	 */
	private onSourceClosed(document: TextDocument): void {
		if (document.uri.scheme !== 'file') {
			return;
		}
		const sourceKey = sourceUriComparisonKey(document.uri);
		this.savedVersions.delete(sourceKey);
		clearTimeout(this.typingTimers.get(sourceKey));
		this.typingTimers.delete(sourceKey);
		for (const artifact of this.documents.values()) {
			if (artifact.sourceKey === sourceKey && artifact.handler.status.sourceText?.unsaved) {
				this.requestRefresh(artifact.uri);
			}
		}
	}

	/** Refreshes a document without the short wait of `requestRefresh`. */
	private refreshNow(document: RegisteredArtifactDocument, { cancel }: { readonly cancel: boolean }): void {
		if (document.pendingRefresh) {
			clearTimeout(document.pendingRefresh);
			document.pendingRefresh = undefined;
		}
		document.handler.markStale({ cancel });
		document.view?.refresh();
	}
}

/** The open text document of a source, also through another path to the same file. */
function openSourceDocument(source: Uri, sourceKey: string): TextDocument | undefined {
	return workspace.textDocuments.find(
		(document) =>
			!document.isClosed && document.uri.scheme === 'file' && sourceUriComparisonKey(document.uri) === sourceKey,
	);
}

/** Whether a variant is the configured default invocation, which finds its toolchain by display name. */
function isDefaultInvocation(variant: CompilationVariant): boolean {
	return variant.provider === 'default' && variant.id.startsWith('default:');
}
