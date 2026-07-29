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
	CompilationOutputMode,
	CompilationVariant,
	CompileArtifact,
} from '../types/index.js';
import { CompilationError } from '../types/index.js';
import { CompiledAssembly } from './compiled-assembly.js';
import * as logger from '../logger.js';
import { partitionFilters } from '../types/filter-options.js';

export interface CompileHandlerResult {
	assembly: CompiledAssembly;
	artifact: CompileArtifact;
}

export type CompilationDocumentState = 'compiling' | 'stale' | 'failed' | 'successful';

export interface CompileHandlerStatus {
	readonly state: CompilationDocumentState;
	readonly assembly?: CompiledAssembly;
	readonly artifact?: CompileArtifact;
	readonly error?: Error;
	readonly truncated: boolean;
}

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
		private readonly outputMode: CompilationOutputMode,
		private readonly compilationService: CompilationService,
	) {
		this.srcUri = srcUri;
		this.asmUri = asmUri;
	}

	async update(externalToken: CancellationToken): Promise<CompileHandlerResult> {
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
			const { outputOptions, displayFilters } = partitionFilters(
				this.compilationService.globalFilterOptions,
			);
			const artifact = await this.compilationService.compile({
				variant: this.variant,
				outputMode: this.outputMode,
				outputOptions,
				filters: displayFilters,
				cancellationToken: cancellation.token,
			});
			if (generation !== this.generation || cancellation.token.isCancellationRequested) {
				throw new CancellationError();
			}

			const lines = artifact.truncated
				&& !artifact.result.asm.some(line => line.text.includes('[truncated;'))
				? [...artifact.result.asm, { text: '[truncated; compiler output was limited]' }]
				: artifact.result.asm;
			const assembly = new CompiledAssembly(this.srcUri, this.asmUri, lines);
			this.setStatus({
				state: 'successful',
				assembly,
				artifact,
				truncated: artifact.truncated,
			});

			return { assembly, artifact };
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
