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
import { CompiledAssembly } from './compiled-assembly.js';
import * as logger from '../logger.js';
import { partitionFilters } from '../parsers/filters.interfaces.js';

export interface CompileHandlerResult {
	assembly: CompiledAssembly;
	artifact: CompileArtifact;
}

export class CompileHandler implements Disposable {
	readonly srcUri: Uri;
	readonly asmUri: Uri;
	private readonly compileEvent = new EventEmitter<CompiledAssembly | Error>();
	private cancellation?: CancellationTokenSource;
	private generation = 0;

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

			const assembly = new CompiledAssembly(this.srcUri, this.asmUri, artifact.result.asm);
			this.compileEvent.fire(assembly);

			return { assembly, artifact };
		} catch (error) {
			if (generation === this.generation && !(error instanceof CancellationError)) {
				const normalized = error instanceof Error ? error : new Error(String(error));
				logger.logChannel.error(`Compilation failed for ${this.srcUri.fsPath}: ${normalized.stack ?? normalized.message}`);
				this.compileEvent.fire(normalized);
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

	get onDidChange(): Event<CompiledAssembly | Error> {
		return this.compileEvent.event;
	}

	dispose(): void {
		this.generation++;
		this.cancellation?.cancel();
		this.cancellation?.dispose();
		this.compileEvent.dispose();
	}
}
