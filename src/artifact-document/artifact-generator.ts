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

interface ArtifactStatusBase {
	readonly artifact?: RenderedArtifact;
	readonly invocation?: InvocationDetails;
	readonly truncated: boolean;
}

export type ArtifactStatus =
	| ({ readonly state: 'compiling' | 'stale' | 'cancelled'; readonly error?: never } & ArtifactStatusBase)
	| ({
			readonly state: 'failed';
			readonly error: Error;
			readonly diagnostics: readonly import('../types/index.js').CompileDiagnostic[];
	  } & ArtifactStatusBase)
	| ({
			readonly state: 'successful';
			readonly artifact: RenderedArtifact;
			readonly error?: never;
	  } & ArtifactStatusBase);

export type ArtifactState = ArtifactStatus['state'];

/** What a generator adds to its preset: the arguments that the user edited, and the listing view. */
export interface ArtifactGeneratorSettings {
	/** Reads the edited arguments for each compile. They follow the preset arguments. */
	readonly extraArguments?: () => readonly string[];
	readonly view?: ArtifactViewOptions;
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

	private earlierArtifact?: RenderedTextArtifact;

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
			});
			if (artifact.status !== 'available') {
				throw new CompilationError(artifact.explanation);
			}
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
			this.keepEarlierArtifact(rendered);
			this.transition('successful', {
				artifact: rendered,
				invocation: this.currentStatus.invocation,
				truncated: rendered.truncated,
			});

			return rendered;
		} catch (error) {
			if (isCurrent() && !(error instanceof CancellationError)) {
				const normalized = error instanceof Error ? error : new Error(String(error));
				logger.logChannel.error(
					`Compilation failed for ${this.sourceUri.fsPath}: ${normalized.stack ?? normalized.message}`,
				);
				this.transition('failed', {
					error: normalized,
					diagnostics: error instanceof CompilationError ? error.diagnostics : [],
					truncated: (error instanceof CompilationError && error.truncated) || this.currentStatus.truncated,
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
	 * Keeps the last successful text listing when a new result has other text. A result with the same
	 * text, such as a refresh without a change, keeps the earlier listing, so a comparison shows a change.
	 */
	private keepEarlierArtifact(next: RenderedArtifact): void {
		const current = this.currentStatus.artifact;
		if (
			current?.presentation === 'text' &&
			next.presentation === 'text' &&
			listingText(current) !== listingText(next)
		) {
			this.earlierArtifact = current;
		}
	}

	/** The successful listing before the current one, when its text is different. */
	get previousArtifact(): RenderedTextArtifact | undefined {
		return this.earlierArtifact;
	}

	get onDidChange(): Event<ArtifactStatus> {
		return this.statusEvent.event;
	}

	get status(): ArtifactStatus {
		return this.currentStatus;
	}

	markStale(): void {
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
			invocation: this.currentStatus.invocation,
			truncated: this.currentStatus.truncated,
			...overrides,
		} as ArtifactStatus;
		this.currentStatus = status;
		this.statusEvent.fire(status);
	}
}

/** The text that a text listing shows, one line for each artifact line. */
export function listingText(artifact: RenderedTextArtifact): string {
	return artifact.lines.map((line) => line.text).join('\n');
}
