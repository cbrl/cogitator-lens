import path from 'node:path';
import { Disposable, Event, EventEmitter, RelativePattern, Uri, workspace } from 'vscode';
import { artifactDefinitions } from '../artifacts/core/artifact-definitions.js';
import type { CompilationService } from '../compilation/index.js';
import type { ConfigurationService } from '../services/configuration-service.js';
import { getArtifactOutputChoices } from '../toolchains/toolchain-map.js';
import type { CompilationVariant, ToolchainProfile } from '../types/index.js';
import { CompilationError } from '../types/index.js';
import { toComparisonKey } from '../utils.js';
import { sourceUriComparisonKey } from '../uri-containers.js';
import { parseArtifactUri, type ArtifactUriIdentity } from './artifact-uri.js';
import { ArtifactGenerator, type ArtifactStatus } from './artifact-generator.js';
import type { ArtifactDocumentIdentity, ArtifactDocumentSnapshot } from './artifact-identity.js';

export interface ArtifactRegistryDocument {
	readonly uri: Uri;
	readonly parsed: ArtifactUriIdentity;
	readonly identity: ArtifactDocumentIdentity;
	readonly handler: ArtifactGenerator;
}

export interface ArtifactDocumentRegistration {
	readonly refresh: (document: ArtifactRegistryDocument) => void;
	readonly onStatus?: (document: ArtifactRegistryDocument, status: ArtifactStatus) => void;
}

interface RegisteredArtifactDocument extends ArtifactRegistryDocument {
	readonly registration: ArtifactDocumentRegistration;
	subscriptions: Disposable;
	pendingRefresh?: ReturnType<typeof setTimeout>;
}

export function artifactDocumentKey(uri: Uri): string {
	return toComparisonKey(uri, true, process.platform === 'win32');
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
		...(parsed.artifactOutputId
			? {
					artifactOutputId: parsed.artifactOutputId,
					artifactOutputLabel: artifactLabel,
				}
			: {}),
		presetId: parsed.presetId,
		variantId: variant.id,
		variantLabel: variant.displayLabel,
		toolchainId: profile?.id ?? variant.toolchainProfileId,
		toolchainLabel: profile?.displayName ?? variant.toolchainProfileId,
		toolchainKind: profile?.kind ?? 'unknown',
		renderedIdentity: uri.toString(),
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

	get(uri: Uri): ArtifactRegistryDocument | undefined {
		return this.documents.get(artifactDocumentKey(uri));
	}

	open(uri: Uri, registration: ArtifactDocumentRegistration): ArtifactRegistryDocument {
		const key = artifactDocumentKey(uri);
		const existing = this.documents.get(key);
		if (existing) {
			return existing;
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
			registration,
			subscriptions: Disposable.from(),
		};
		document.subscriptions = Disposable.from(
			watcher,
			watcher.onDidChange(() => this.requestRefresh(uri)),
			handler.onDidChange((status) => {
				registration.onStatus?.(document, status);
				this.stateEmitter.fire({ identity: document.identity, status });
			}),
		);
		this.documents.set(key, document);
		this.stateEmitter.fire(this.snapshot(document));
		return document;
	}

	requestRefresh(uri: Uri): void {
		const document = this.documents.get(artifactDocumentKey(uri));
		if (!document) {
			return;
		}
		document.handler.markStale();
		if (document.pendingRefresh) {
			clearTimeout(document.pendingRefresh);
		}
		document.pendingRefresh = setTimeout(() => {
			document.pendingRefresh = undefined;
			document.registration.refresh(document);
		}, 50);
	}

	unregister(uri: Uri): void {
		const key = artifactDocumentKey(uri);
		const document = this.documents.get(key);
		if (!document) {
			return;
		}
		this.documents.delete(key);
		if (document.pendingRefresh) {
			clearTimeout(document.pendingRefresh);
		}
		document.subscriptions.dispose();
		document.handler.dispose();
	}

	dispose(): void {
		this.subscriptions.dispose();
		for (const document of [...this.documents.values()]) {
			this.unregister(document.uri);
		}
	}

	private snapshot(document: ArtifactRegistryDocument): ArtifactDocumentSnapshot {
		return { identity: document.identity, status: document.handler.status };
	}
}
