import {
	CancellationError,
	CancellationToken,
	CancellationTokenSource,
	Disposable,
	Event,
	EventEmitter,
	Uri,
} from 'vscode';
import path from 'path';
import { CompilationService } from '../compilation/index.js';
import type {
	ArtifactKind,
	CompilationVariant,
	InvocationDetails,
	RenderedArtifact,
	RenderedTextArtifact,
} from '../types/index.js';
import { CompilationError } from '../types/index.js';
import { artifactDefinitions } from '../artifacts/core/artifact-definitions.js';
import { applyArtifactView, type ArtifactViewOptions } from '../artifacts/core/artifact-views.js';
import * as logger from '../logger.js';

/** The text of the source that an artifact comes from. */
export interface ArtifactSourceText {
	/** The version of the open source document that has this text, when it is known. */
	readonly version?: number;
	/** Whether the compile read the unsaved text of the document, not the saved file. */
	readonly unsaved: boolean;
	/** Why the compile read the saved file although the setting asked for the unsaved text. */
	readonly savedFileReason?: string;
}

interface ArtifactStatusBase {
	readonly artifact?: RenderedArtifact;
	/** The source text of the artifact. It changes together with the artifact. */
	readonly sourceText?: ArtifactSourceText;
	readonly invocation?: InvocationDetails;
	readonly truncated: boolean;
}

export type ArtifactStatus =
	| ({ readonly state: 'compiling' | 'stale' | 'cancelled'; readonly error?: never } & ArtifactStatusBase)
	| ({
			readonly state: 'failed';
			readonly error: Error;
			readonly diagnostics: readonly import('../types/index.js').CompileDiagnostic[];
			/** Whether the failed compile read unsaved text. The listing, if any, is from an earlier compile. */
			readonly readUnsavedText: boolean;
	  } & ArtifactStatusBase)
	| ({
			readonly state: 'successful';
			readonly artifact: RenderedArtifact;
			readonly error?: never;
	  } & ArtifactStatusBase);

export type ArtifactState = ArtifactStatus['state'];

/** The open document of a source when a compile starts. */
export interface SourceDocumentState {
	/** The version of the document now. */
	readonly version: number;
	/** The version that has the text of the saved file, when it is known. */
	readonly savedVersion?: number;
	/** The unsaved text, when the compile must read it in place of the saved file. */
	readonly unsavedText?: string;
}

/** What a generator adds to its preset: the arguments that the user edited, and the listing view. */
export interface ArtifactGeneratorSettings {
	/** Reads the edited arguments for each compile. They follow the preset arguments. */
	readonly extraArguments?: () => readonly string[];
	readonly view?: ArtifactViewOptions;
	/** The function whose output the compile prints, for a kind that requires a function filter. */
	readonly functionFilter?: string;
	/** Reads the open document of the source for each compile. */
	readonly sourceDocument?: () => SourceDocumentState | undefined;
}

export class ArtifactGenerator implements Disposable {
	readonly sourceUri: Uri;
	readonly artifactUri: Uri;
	private readonly statusEvent = new EventEmitter<ArtifactStatus>();
	private cancellation?: CancellationTokenSource;
	private currentStatus: ArtifactStatus = {
		state: 'stale',
		truncated: false,
	};

	/** The text of the current listing, so each result compares with it once. */
	private currentText?: string;
	private earlierText?: string;

	constructor(
		sourceUri: Uri,
		artifactUri: Uri,
		private readonly variantId: string,
		private readonly artifactKind: ArtifactKind,
		private readonly presetId: string,
		private readonly compilationService: CompilationService,
		private readonly artifactOutputId?: string,
		private readonly settings: ArtifactGeneratorSettings = {},
	) {
		this.sourceUri = sourceUri;
		this.artifactUri = artifactUri;
	}

	async update(externalToken: CancellationToken): Promise<RenderedArtifact> {
		this.cancellation?.cancel();
		this.cancellation?.dispose();
		const cancellation = new CancellationTokenSource();
		this.cancellation = cancellation;
		// A newer call to update() cancels and replaces `this.cancellation` before doing
		// anything else, so comparing identity against it is a complete staleness check —
		// no separate generation counter is needed alongside the token source.
		const isCurrent = (): boolean => this.cancellation === cancellation;
		const externalSubscription = externalToken.onCancellationRequested(() => cancellation.cancel());
		this.transition('compiling');
		const document = this.settings.sourceDocument?.();
		const unsavedText = document?.unsavedText;

		try {
			const variant = await this.resolveVariant();
			if (!isCurrent() || cancellation.token.isCancellationRequested) {
				throw new CancellationError();
			}
			const preset = this.compilationService.getArtifactPreset(this.artifactKind, this.presetId, this.sourceUri);
			if (!preset) {
				throw new CompilationError(
					`Artifact preset "${this.presetId}" does not exist or does not produce ${this.artifactKind}.`,
				);
			}
			const baseOptions = this.compilationService.getArtifactOptions(this.artifactKind);
			const artifact = await this.compilationService.compile({
				variant,
				artifactKind: this.artifactKind,
				...(this.artifactOutputId ? { artifactOutputId: this.artifactOutputId } : {}),
				presetId: this.presetId,
				extraArguments: [...preset.extraArguments, ...(this.settings.extraArguments?.() ?? [])],
				options: {
					production: {
						...baseOptions.production,
						...preset.productionOptions,
					},
					display: baseOptions.display,
				},
				cancellationToken: cancellation.token,
				onInvocation: (invocation) => {
					if (!isCurrent() || cancellation.token.isCancellationRequested) {
						return;
					}
					this.transition('compiling', { invocation });
				},
				...(unsavedText === undefined ? {} : { unsavedText }),
				...(this.settings.functionFilter === undefined ? {} : { functionFilter: this.settings.functionFilter }),
			});
			if (artifact.status !== 'available') {
				throw new CompilationError(artifact.explanation);
			}
			const use = artifact.unsavedText;
			const sourceText: ArtifactSourceText = use?.read
				? { version: document?.version, unsaved: true }
				: {
						version: document?.savedVersion,
						unsaved: false,
						...(use ? { savedFileReason: use.reason } : {}),
					};
			if (!isCurrent() || cancellation.token.isCancellationRequested) {
				throw new CancellationError();
			}

			const rendered = applyArtifactView(artifact.artifact, this.settings.view);
			const expectedPresentation = artifactDefinitions[this.artifactKind].presentation;
			if (rendered.presentation !== expectedPresentation) {
				throw new CompilationError(
					`${this.artifactKind} produced a ${rendered.presentation} artifact; expected ${expectedPresentation}.`,
				);
			}
			this.keepEarlierText(rendered);
			this.transition('successful', {
				artifact: rendered,
				sourceText,
				invocation: this.currentStatus.invocation,
				truncated: rendered.truncated,
			});

			return rendered;
		} catch (error) {
			if (isCurrent() && !(error instanceof CancellationError)) {
				const normalized = error instanceof Error ? error : new Error(String(error));
				const readUnsavedText = error instanceof CompilationError && error.unsavedText?.read === true;
				// A compile of unsaved text fails often while the user types, so it goes to the log as a debug line.
				const message = `Compilation failed for ${this.sourceUri.fsPath}: ${normalized.stack ?? normalized.message}`;
				if (readUnsavedText) {
					logger.logChannel.debug(message);
				} else {
					logger.logChannel.error(message);
				}
				this.transition('failed', {
					error: normalized,
					diagnostics: error instanceof CompilationError ? error.diagnostics : [],
					truncated: (error instanceof CompilationError && error.truncated) || this.currentStatus.truncated,
					readUnsavedText,
				});
			} else if (isCurrent()) {
				this.transition('cancelled');
			}

			throw error;
		} finally {
			externalSubscription.dispose();
			if (isCurrent()) {
				cancellation.dispose();
				this.cancellation = undefined;
			}
		}
	}

	/**
	 * Looks the variant up for every update, so edits to it, a provider refresh, or a toolchain change
	 * apply to an open artifact. A restored artifact waits for the providers that describe its source.
	 */
	private async resolveVariant(): Promise<CompilationVariant> {
		let variant = this.compilationService.findVariant(this.sourceUri, this.variantId);
		if (!variant && !this.compilationService.providersAreReady) {
			await this.compilationService.whenProvidersReady();
			variant = this.compilationService.findVariant(this.sourceUri, this.variantId);
		}
		if (!variant) {
			throw new CompilationError(
				`The compilation variant of this artifact is no longer available for ${path.basename(this.sourceUri.fsPath)}. ` +
					'Open the artifact again from the source to use its current variant.',
			);
		}
		return variant;
	}

	/**
	 * Keeps the text of the last successful listing when a new result has other text. A result with
	 * the same text, such as a refresh without a change, keeps the earlier text, so a comparison shows
	 * a change. Only the text stays, because a full listing can be large.
	 */
	private keepEarlierText(next: RenderedArtifact): void {
		const nextText = next.presentation === 'text' ? listingText(next) : undefined;
		if (this.currentText !== undefined && nextText !== undefined && this.currentText !== nextText) {
			this.earlierText = this.currentText;
		}
		this.currentText = nextText;
	}

	/** The text of the successful listing before the current one, when that text is different. */
	get previousText(): string | undefined {
		return this.earlierText;
	}

	get onDidChange(): Event<ArtifactStatus> {
		return this.statusEvent.event;
	}

	get status(): ArtifactStatus {
		return this.currentStatus;
	}

	/**
	 * Marks the artifact stale. With `cancel`, a running compile stops at once, and it reports no
	 * cancelled state, because a new compile follows. A compile of text that the user has since
	 * changed is of no use.
	 */
	markStale({ cancel = false }: { readonly cancel?: boolean } = {}): void {
		const running = cancel ? this.cancellation : undefined;
		if (running) {
			// The running update is no longer current, so it reports nothing.
			this.cancellation = undefined;
			running.cancel();
			running.dispose();
		}
		if (this.currentStatus.state !== 'stale') {
			this.transition('stale');
		}
	}

	/** Whether a compile is in progress. A refresh request makes the state stale before the compile ends. */
	get generating(): boolean {
		return this.cancellation !== undefined;
	}

	cancel(): boolean {
		// Use the token, not the state. A refresh request sets the state to stale during a compile.
		if (!this.cancellation) {
			return false;
		}
		this.cancellation.cancel();
		return true;
	}

	dispose(): void {
		this.cancellation?.cancel();
		this.cancellation?.dispose();
		this.cancellation = undefined;
		this.statusEvent.dispose();
	}

	private transition<S extends ArtifactState>(state: S, overrides: Partial<ArtifactStatus> = {}): void {
		const status = {
			state,
			artifact: this.currentStatus.artifact,
			sourceText: this.currentStatus.sourceText,
			invocation: this.currentStatus.invocation,
			truncated: this.currentStatus.truncated,
			...overrides,
		} as ArtifactStatus;
		this.currentStatus = status;
		this.statusEvent.fire(status);
	}
}

/**
 * The text listing of a successful compile. In each other state, the listing can come from an
 * earlier version of the source, so its source lines can be wrong for the saved file.
 */
export function currentListing(status: ArtifactStatus): RenderedTextArtifact | undefined {
	return status.state === 'successful' && status.artifact.presentation === 'text' ? status.artifact : undefined;
}

/**
 * Whether an artifact shows the saved file while its source has unsaved edits, and no compile of
 * those edits follows. With `coglens.compileOnType`, each pause in typing compiles the unsaved text,
 * unless the toolchain reads only the saved file. Then the source text gives the reason.
 */
export function showsSavedFileOnly(sourceText: ArtifactSourceText | undefined, compileOnType: boolean): boolean {
	return !sourceText?.unsaved && (!compileOnType || sourceText?.savedFileReason !== undefined);
}

/**
 * Whether the listing of a status has the lines of the text that a source document holds now. A
 * listing of a known version matches that version. A listing of the saved file also matches each
 * version without unsaved changes.
 */
export function listingMatchesDocument(
	status: ArtifactStatus,
	document: { readonly version: number; readonly isDirty: boolean },
): boolean {
	const { sourceText } = status;
	return sourceText?.version === document.version || (!document.isDirty && !sourceText?.unsaved);
}

/** The text that a text listing shows, one line for each artifact line. */
export function listingText(artifact: RenderedTextArtifact): string {
	return artifact.lines.map((line) => line.text).join('\n');
}
