import {
	CancellationError,
	CancellationToken,
	CancellationTokenSource,
	Disposable,
	Event,
	EventEmitter,
	Uri,
} from 'vscode';
import { CompilationService } from '../compilation/index.js';
import type {
	ArtifactKind,
	CompilationVariant,
	InvocationDetails,
	RenderedArtifact,
} from '../types/index.js';
import { CompilationError } from '../types/index.js';
import { buildCompiledAssembly, type CompiledAssembly } from './compiled-assembly.js';
import { artifactDefinitions } from '../artifacts/artifact-definitions.js';
import * as logger from '../logger.js';

export interface ArtifactHandlerResult {
	assembly?: CompiledAssembly;
	artifact: RenderedArtifact;
}

interface RetainedArtifactStatus {
	readonly assembly?: CompiledAssembly;
	readonly artifact?: RenderedArtifact;
	readonly invocation?: InvocationDetails;
	readonly error?: never;
	readonly truncated: boolean;
}

export type CompileHandlerStatus =
	| ({ readonly state: 'compiling' | 'stale' | 'cancelled' } & RetainedArtifactStatus)
	| {
		readonly state: 'failed';
		readonly error: Error;
		readonly diagnostics: readonly import('../types/index.js').CompileDiagnostic[];
		readonly assembly?: CompiledAssembly;
		readonly artifact?: RenderedArtifact;
		readonly invocation?: InvocationDetails;
		readonly truncated: boolean;
	}
	| {
		readonly state: 'successful';
		readonly assembly?: CompiledAssembly;
		readonly artifact: RenderedArtifact;
		readonly invocation?: InvocationDetails;
		readonly error?: never;
		readonly truncated: boolean;
	};

export type CompilationDocumentState = CompileHandlerStatus['state'];

export class CompileHandler implements Disposable {
	readonly srcUri: Uri;
	readonly asmUri: Uri;
	private readonly statusEvent = new EventEmitter<CompileHandlerStatus>();
	private cancellation?: CancellationTokenSource;
	private currentStatus: CompileHandlerStatus = {
		state: 'stale',
		truncated: false,
	};

	constructor(
		srcUri: Uri,
		asmUri: Uri,
		private readonly variant: CompilationVariant,
		private readonly artifactKind: ArtifactKind,
		private readonly presetId: string,
		private readonly compilationService: CompilationService,
		private readonly artifactOutputId?: string,
	) {
		this.srcUri = srcUri;
		this.asmUri = asmUri;
	}

	async update(externalToken: CancellationToken): Promise<ArtifactHandlerResult> {
		this.cancellation?.cancel();
		this.cancellation?.dispose();
		const cancellation = new CancellationTokenSource();
		this.cancellation = cancellation;
		// A newer call to update() cancels and replaces `this.cancellation` before doing
		// anything else, so comparing identity against it is a complete staleness check —
		// no separate generation counter is needed alongside the token source.
		const isCurrent = (): boolean => this.cancellation === cancellation;
		const externalSubscription = externalToken.onCancellationRequested(() => cancellation.cancel());
		this.setStatus({
			state: 'compiling',
			assembly: this.currentStatus.assembly,
			artifact: this.currentStatus.artifact,
			invocation: this.currentStatus.invocation,
			truncated: this.currentStatus.truncated,
		});

		try {
			const preset = this.compilationService.getArtifactPreset(
				this.artifactKind,
				this.presetId,
				this.srcUri,
			);
			if (!preset) {
				throw new CompilationError(
					`Artifact preset "${this.presetId}" does not exist or does not produce ${this.artifactKind}.`,
				);
			}
			const baseOptions = this.compilationService.getArtifactOptions(this.artifactKind);
			const artifact = await this.compilationService.compile({
				variant: this.variant,
				artifactKind: this.artifactKind,
				...(this.artifactOutputId ? { artifactOutputId: this.artifactOutputId } : {}),
				presetId: this.presetId,
				extraArguments: preset.extraArguments,
				options: {
					production: {
						...baseOptions.production,
						...preset.productionOptions,
					},
					display: baseOptions.display,
				},
				cancellationToken: cancellation.token,
				onInvocation: invocation => {
					if (!isCurrent() || cancellation.token.isCancellationRequested) {
						return;
					}
					this.setStatus({
						state: 'compiling',
						assembly: this.currentStatus.assembly,
						artifact: this.currentStatus.artifact,
						invocation,
						truncated: this.currentStatus.truncated,
					});
				},
			});
			if (artifact.status !== 'available') {
				throw new CompilationError(artifact.explanation);
			}
			if (!isCurrent() || cancellation.token.isCancellationRequested) {
				throw new CancellationError();
			}

			const rendered = artifact.artifact;
			const expectedPresentation = artifactDefinitions[this.artifactKind].presentation;
			if (rendered.presentation !== expectedPresentation) {
				throw new CompilationError(
					`${this.artifactKind} produced a ${rendered.presentation} artifact; expected ${expectedPresentation}.`,
				);
			}
			const assembly = rendered.presentation === 'text'
				? buildCompiledAssembly(
					this.srcUri,
					this.asmUri,
					rendered.toolOutputTruncated
						? [...rendered.lines, { text: '[truncated; toolchain output was limited]' }]
						: rendered.lines,
				)
				: undefined;
			this.setStatus({
				state: 'successful',
				assembly,
				artifact: rendered,
				invocation: this.currentStatus.invocation,
				truncated: rendered.truncated,
			});

			return { assembly, artifact: rendered };
		} catch (error) {
			if (isCurrent() && !(error instanceof CancellationError)) {
				const normalized = error instanceof Error ? error : new Error(String(error));
				logger.logChannel.error(`Compilation failed for ${this.srcUri.fsPath}: ${normalized.stack ?? normalized.message}`);
				this.setStatus({
					state: 'failed',
					error: normalized,
					diagnostics: error instanceof CompilationError ? error.diagnostics : [],
					assembly: this.currentStatus.assembly,
					artifact: this.currentStatus.artifact,
					invocation: this.currentStatus.invocation,
					truncated: (error instanceof CompilationError && error.truncated)
						|| this.currentStatus.truncated,
				});
			} else if (isCurrent()) {
				this.setStatus({
					state: 'cancelled',
					assembly: this.currentStatus.assembly,
					artifact: this.currentStatus.artifact,
					invocation: this.currentStatus.invocation,
					truncated: this.currentStatus.truncated,
				});
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

	get onDidChange(): Event<CompileHandlerStatus> {
		return this.statusEvent.event;
	}

	get status(): CompileHandlerStatus {
		return this.currentStatus;
	}

	markStale(): void {
		if (this.currentStatus.state !== 'stale') {
			this.setStatus({
				state: 'stale',
				assembly: this.currentStatus.assembly,
				artifact: this.currentStatus.artifact,
				invocation: this.currentStatus.invocation,
				truncated: this.currentStatus.truncated,
			});
		}
	}

	dispose(): void {
		this.cancellation?.cancel();
		this.cancellation?.dispose();
		this.cancellation = undefined;
		this.statusEvent.dispose();
	}

	private setStatus(status: CompileHandlerStatus): void {
		this.currentStatus = status;
		this.statusEvent.fire(status);
	}
}
