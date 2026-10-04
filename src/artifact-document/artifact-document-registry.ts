import path from 'node:path';
import { Disposable, Event, EventEmitter, RelativePattern, Uri, workspace } from 'vscode';
import { artifactDefinitions } from '../artifacts/core/artifact-definitions.js';
import type { CompilationService } from '../compilation/index.js';
import type { ConfigurationService } from '../services/configuration-service.js';
import { getArtifactOutputChoices } from '../toolchains/toolchain-artifacts.js';
import type { CompilationVariant, ToolchainProfile } from '../types/index.js';
import { CompilationError } from '../types/index.js';
import { sourceUriComparisonKey, uriComparisonKey } from '../file-identity.js';
import { parseArtifactUri, type ArtifactUriIdentity } from './artifact-uri.js';
import { ArtifactGenerator, type ArtifactStatus } from './artifact-generator.js';
import type { ArtifactDocumentIdentity, ArtifactDocumentSnapshot } from './artifact-identity.js';

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
	view?: ArtifactView;
	subscriptions: Disposable;
	pendingRefresh?: ReturnType<typeof setTimeout>;
}

export function buildArtifactIdentity(
	uri: Uri,
	parsed: ArtifactUriIdentity,
	variant: CompilationVariant,
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
		presetId: parsed.presetId,
		variantId: variant.id,
		variantLabel: variant.displayLabel,
		toolchainId: profile?.id ?? variant.toolchainProfileId,
		toolchainLabel: profile?.displayName ?? variant.toolchainProfileId,
		toolchainKind: profile?.kind ?? 'unknown',
	};
}

/** Shared lifecycle, invalidation, and identity owner for text documents and graph panels. */
export class ArtifactDocumentRegistry implements Disposable {
	private readonly documents = new Map<string, RegisteredArtifactDocument>();
	private readonly stateEmitter = new EventEmitter<ArtifactDocumentSnapshot>();
	private readonly subscriptions: Disposable;

	readonly onDidChangeArtifactState: Event<ArtifactDocumentSnapshot> = this.stateEmitter.event;

	constructor(
		private readonly compilationService: CompilationService,
		configuration: ConfigurationService,
	) {
		this.subscriptions = Disposable.from(
			compilationService.onVariantsChanged((sources) => {
				const changed = new Set(sources.map(sourceUriComparisonKey));
				for (const document of this.documents.values()) {
					if (changed.has(sourceUriComparisonKey(document.parsed.source))) {
						this.requestRefresh(document.uri);
					}
				}
			}),
			compilationService.onArtifactOptionsChanged((kind) => {
				for (const document of this.documents.values()) {
					if (document.parsed.artifactKind === kind) {
						this.requestRefresh(document.uri);
					}
				}
			}),
			configuration.onDidChange(() => {
				for (const document of this.documents.values()) {
					this.requestRefresh(document.uri);
				}
			}),
			this.stateEmitter,
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
		const variant = this.compilationService
			.getVariants(parsed.source)
			.find((candidate) => candidate.id === parsed.variantId);
		if (!variant) {
			throw new CompilationError(`Compilation variant is no longer available: ${parsed.variantId}`);
		}
		const profile = this.compilationService.toolchainRegistry.getToolchainById(variant.toolchainProfileId)?.profile;
		const handler = new ArtifactGenerator(
			parsed.source,
			uri,
			variant,
			parsed.artifactKind,
			parsed.presetId,
			this.compilationService,
			parsed.artifactOutputId,
		);
		const watcher = workspace.createFileSystemWatcher(
			new RelativePattern(Uri.file(path.dirname(parsed.source.fsPath)), path.basename(parsed.source.fsPath)),
		);
		const document: RegisteredArtifactDocument = {
			uri,
			parsed,
			identity: buildArtifactIdentity(uri, parsed, variant, profile),
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
				view.onStatus(status);
				this.stateEmitter.fire(document.snapshot);
			}),
		);
		this.documents.set(key, document);
		this.stateEmitter.fire(document.snapshot);
		return view;
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
	}

	dispose(): void {
		this.subscriptions.dispose();
		for (const document of [...this.documents.values()]) {
			this.unregister(document.uri);
		}
	}
}
