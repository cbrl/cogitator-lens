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
	RenderedArtifact,
} from '../types/index.js';
import { CompilationError } from '../types/index.js';
import { CompiledAssembly } from './compiled-assembly.js';
import * as logger from '../logger.js';

export interface ArtifactHandlerResult {
	assembly: CompiledAssembly;
	artifact: RenderedArtifact;
}

interface RetainedArtifactStatus {
	readonly assembly?: CompiledAssembly;
	readonly artifact?: RenderedArtifact;
	readonly error?: never;
	readonly truncated: boolean;
}

export type CompileHandlerStatus =
	| ({ readonly state: 'compiling' | 'stale' } & RetainedArtifactStatus)
	| {
		readonly state: 'failed';
		readonly error: Error;
		readonly assembly?: never;
		readonly artifact?: never;
		readonly truncated: boolean;
	}
	| {
		readonly state: 'successful';
		readonly assembly: CompiledAssembly;
		readonly artifact: RenderedArtifact;
		readonly error?: never;
		readonly truncated: boolean;
	};

export type CompilationDocumentState = CompileHandlerStatus['state'];

export class CompileHandler implements Disposable {
	readonly srcUri: Uri;
	readonly asmUri: Uri;
	private readonly statusEvent = new EventEmitter<CompileHandlerStatus>();
	private cancellation?: CancellationTokenSource;
	private generation = 0;
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
	) {
		this.srcUri = srcUri;
		this.asmUri = asmUri;
	}

	async update(externalToken: CancellationToken): Promise<ArtifactHandlerResult> {
		const generation = ++this.generation;
		this.cancellation?.cancel();
		this.cancellation?.dispose();
		const cancellation = new CancellationTokenSource();
		this.cancellation = cancellation;
		const externalSubscription = externalToken.onCancellationRequested(() => cancellation.cancel());
		this.setStatus({
			state: 'compiling',
			assembly: this.currentStatus.assembly,
			artifact: this.currentStatus.artifact,
			truncated: this.currentStatus.truncated,
		});

		try {
			const backend = this.compilationService.toolchainRegistry
				.getToolchainById(this.variant.toolchainProfileId);
			if (!backend) {
				throw new CompilationError(
					`Toolchain profile not found: ${this.variant.toolchainProfileId}`,
				);
			}
			const artifact = await this.compilationService.compile({
				variant: this.variant,
				toolchain: backend.profile,
				artifactKind: this.artifactKind,
				presetId: this.presetId,
				extraArguments: [],
				options: this.compilationService.getArtifactOptions(this.artifactKind),
				cancellationToken: cancellation.token,
			});
			if (artifact.status !== 'available') {
				throw new CompilationError(artifact.explanation);
			}
			if (generation !== this.generation || cancellation.token.isCancellationRequested) {
				throw new CancellationError();
			}

			const rendered = artifact.artifact;
			const lines = rendered.truncated
				&& !rendered.lines.some(line => line.text.includes('[truncated;'))
				? [...rendered.lines, { text: '[truncated; toolchain output was limited]' }]
				: [...rendered.lines];
			const assembly = new CompiledAssembly(this.srcUri, this.asmUri, lines);
			this.setStatus({
				state: 'successful',
				assembly,
				artifact: rendered,
				truncated: rendered.truncated,
			});

			return { assembly, artifact: rendered };
		} catch (error) {
			if (generation === this.generation && !(error instanceof CancellationError)) {
				const normalized = error instanceof Error ? error : new Error(String(error));
				logger.logChannel.error(`Compilation failed for ${this.srcUri.fsPath}: ${normalized.stack ?? normalized.message}`);
				this.setStatus({
					state: 'failed',
					error: normalized,
					truncated: error instanceof CompilationError && error.truncated,
				});
			} else if (generation === this.generation) {
				this.setStatus({
					state: 'stale',
					assembly: this.currentStatus.assembly,
					artifact: this.currentStatus.artifact,
					truncated: this.currentStatus.truncated,
				});
			}

			throw error;
		} finally {
			externalSubscription.dispose();
			if (generation === this.generation) {
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
				truncated: this.currentStatus.truncated,
			});
		}
	}

	dispose(): void {
		this.generation++;
		this.cancellation?.cancel();
		this.cancellation?.dispose();
		this.statusEvent.dispose();
	}

	private setStatus(status: CompileHandlerStatus): void {
		this.currentStatus = status;
		this.statusEvent.fire(status);
	}
}
