import {
	CancellationError,
	Disposable,
	Event,
	EventEmitter,
	Memento,
	Uri,
	workspace,
} from 'vscode';
import fs from 'fs';
import path from 'path';
import type { ICompilationService, IConfigurationService } from '../interfaces/index.js';
import type {
	CompilationVariant,
	RenderedArtifact,
	ArtifactRequest,
	ArtifactOptionId,
	ArtifactOptions,
	ProviderSnapshot,
} from '../types/index.js';
import {
	artifactOptionsEqual,
	CompilationError,
	immutableArtifactOptions,
} from '../types/index.js';
import { ToolExitError, type ToolchainRunResult } from '../toolchains/toolchain-backend.js';
import { ExecError } from '../exec.js';
import { ToolchainRegistry } from './toolchain-registry.js';
import { CompilationConfigDatabase } from './compilation-config.js';
import { CompilationSemaphore } from './compilation-semaphore.js';
import { parseToolDiagnostics } from '../diagnostics.js';
import * as logger from '../logger.js';

export class CompilationService implements ICompilationService {
	readonly toolchainRegistry = new ToolchainRegistry();
	private readonly variants = new CompilationConfigDatabase();
	private readonly changeEmitter = new EventEmitter<readonly Uri[]>();
	private readonly artifactOptionsChangeEmitter = new EventEmitter<void>();
	private readonly subscriptions: Disposable[] = [];
	private readonly semaphore = new CompilationSemaphore(2, () => new CancellationError());
	private readonly rawAssemblyCache = new Map<string, {
		signature: string;
		run: ToolchainRunResult;
	}>();
	private currentArtifactOptions: ArtifactOptions;

	readonly onVariantsChanged: Event<readonly Uri[]> = this.changeEmitter.event;
	readonly onArtifactOptionsChanged: Event<void> = this.artifactOptionsChangeEmitter.event;

	constructor(
		private readonly configuration: IConfigurationService,
		private readonly workspaceState?: Memento,
	) {
		this.currentArtifactOptions = configuration.getArtifactOptions();
		this.reloadUserConfiguration();
		this.subscriptions.push(
			configuration.onDidChange(() => this.reloadUserConfiguration()),
			this.variants.onDidChange(change => this.changeEmitter.fire(change.affectedSources)),
			this.toolchainRegistry.onDidChange(() => this.changeEmitter.fire(this.variantsSources())),
		);
	}

	get artifactOptions(): ArtifactOptions {
		return this.currentArtifactOptions;
	}

	setArtifactOption(id: ArtifactOptionId, value: boolean): void {
		const production = Object.hasOwn(this.currentArtifactOptions.production, id)
			? { ...this.currentArtifactOptions.production, [id]: value }
			: this.currentArtifactOptions.production;
		const display = Object.hasOwn(this.currentArtifactOptions.display, id)
			? { ...this.currentArtifactOptions.display, [id]: value }
			: this.currentArtifactOptions.display;
		const options = immutableArtifactOptions({ production, display });
		if (artifactOptionsEqual(this.currentArtifactOptions, options)) {
			return;
		}
		this.currentArtifactOptions = options;
		this.artifactOptionsChangeEmitter.fire();
		const folder = workspace.workspaceFolders?.[0];
		void this.configuration.updateArtifactOptions(options, folder);
	}

	getVariants(file: Uri): readonly CompilationVariant[] {
		const variants = this.variants.getVariants(file);
		if (variants.length > 0) {
			return variants;
		}
		const fallback = this.createDefaultVariant(file);
		return fallback ? [fallback] : [];
	}

	getAllSources(): readonly Uri[] {
		return this.variants.getAllSources();
	}

	getSelectedVariant(file: Uri): CompilationVariant | undefined {
		return this.variants.getSelectedVariant(file) ?? this.createDefaultVariant(file);
	}

	hasExplicitVariantSelection(file: Uri): boolean {
		return this.variants.hasSelectedVariant(file);
	}

	async selectVariant(file: Uri, variantId: string): Promise<boolean> {
		const selected = this.variants.selectVariant(file, variantId);
		if (selected) {
			await this.workspaceState?.update(this.selectionKey(file), variantId);
		}
		return selected;
	}

	reconcileProviderSnapshot(snapshot: ProviderSnapshot): void {
		this.toolchainRegistry.reconcile(snapshot.provider, snapshot.toolchainProfiles);
		this.variants.reconcile(snapshot.provider, snapshot.variants.map(variant => ({
			...variant,
			toolchainProfileId: ToolchainRegistry.profileId(snapshot.provider, variant.toolchainProfileId),
		})));
		const sources = new Map(snapshot.variants.map(variant => [variant.source.toString(), variant.source]));
		for (const source of sources.values()) {
			const persisted = this.workspaceState?.get<string>(this.selectionKey(source));
			if (persisted) {
				this.variants.selectVariant(source, persisted);
			}
		}
	}

	async compile(request: ArtifactRequest): Promise<RenderedArtifact> {
		const { variant, outputMode, options, cancellationToken } = request;
		const file = variant.source;
		if (cancellationToken.isCancellationRequested) {
			throw new CancellationError();
		}
		if (outputMode !== 'assembly') {
			throw new CompilationError(`Unsupported compilation output mode: ${outputMode as string}`);
		}
		const backend = this.toolchainRegistry.getToolchainById(variant.toolchainProfileId);
		if (!backend) {
			throw new CompilationError(`Toolchain profile not found: ${variant.toolchainProfileId}`);
		}

		const cacheKey = `${file.toString()}\0${variant.id}\0${outputMode}`;
		const signature = await this.compileSignature(variant, backend.profile, options.production);
		const cached = this.rawAssemblyCache.get(cacheKey);
		if (cached?.signature === signature) {
			return this.createArtifact(backend, cached.run, variant, options.display);
		}

		await this.semaphore.acquire(cancellationToken);
		try {
			if (cancellationToken.isCancellationRequested) {
				throw new CancellationError();
			}

			try {
				const run = await backend.compile(file.fsPath, {
					args: variant.arguments,
					env: variant.environment,
					workingDirectory: variant.workingDirectory,
					productionOptions: options.production,
				}, cancellationToken);
				this.rawAssemblyCache.set(cacheKey, { signature, run });
				return this.createArtifact(backend, run, variant, options.display);
			} catch (error: unknown) {
				if (error instanceof CancellationError || cancellationToken.isCancellationRequested) {
					throw new CancellationError();
				}
				if (error instanceof CompilationError) {
					throw error;
				}
				const output = toolErrorOutput(error);
				const diagnostics = parseToolDiagnostics(
					`${output.stderr}\n${output.stdout}`,
					file,
					variant.workingDirectory,
				);
				const message = error instanceof Error ? error.message : String(error);
				throw new CompilationError(
					message,
					diagnostics,
					error instanceof ExecError && error.kind === 'output-limit',
					{ cause: error instanceof Error ? error : undefined },
				);
			}
		} finally {
			this.semaphore.release();
		}
	}

	dispose(): void {
		this.subscriptions.forEach(subscription => subscription.dispose());
		this.changeEmitter.dispose();
		this.artifactOptionsChangeEmitter.dispose();
		this.variants.dispose();
		this.toolchainRegistry.dispose();
		this.rawAssemblyCache.clear();
	}

	private createArtifact(
		backend: import('../toolchains/toolchain-backend.js').ToolchainBackend,
		run: ToolchainRunResult,
		variant: CompilationVariant,
		options: import('../types/index.js').DisplayOptions,
	): RenderedArtifact {
		let result;
		try {
			result = backend.parseAssembly(run.rawAssembly, options);
		} catch (error: unknown) {
			throw new CompilationError(
				error instanceof Error ? error.message : String(error),
				[],
				false,
				{ cause: error instanceof Error ? error : undefined },
			);
		}
		return {
			result,
			rawAssembly: run.rawAssembly,
			diagnostics: parseToolDiagnostics(
				`${run.stderr}\n${run.stdout}`,
				variant.source,
				variant.workingDirectory,
			),
			durationMs: run.durationMs,
			command: run.command,
			truncated: run.truncated || result.asm.some(line =>
				line.text.includes('[truncated; too many lines]')),
		};
	}

	private async compileSignature(
		variant: CompilationVariant,
		profile: import('../types/index.js').ToolchainProfile,
		productionOptions: import('../types/index.js').ProductionOptions,
	): Promise<string> {
		let sourceState: { size: number; mtimeMs: number };
		try {
			const stat = await fs.promises.stat(variant.source.fsPath);
			sourceState = { size: stat.size, mtimeMs: stat.mtimeMs };
		} catch {
			sourceState = { size: -1, mtimeMs: -1 };
		}
		return JSON.stringify({ variant, profile, productionOptions, sourceState });
	}

	private reloadUserConfiguration(): void {
		try {
			this.toolchainRegistry.reconcile('user', this.configuration.getToolchains());
			const options = this.configuration.getArtifactOptions();
			if (!artifactOptionsEqual(this.currentArtifactOptions, options)) {
				this.currentArtifactOptions = options;
				this.artifactOptionsChangeEmitter.fire();
			}
		} catch (error) {
			logger.logChannel.error(`Failed to reload Cogitator Lens configuration: ${String(error)}`);
		}
	}

	private createDefaultVariant(file: Uri): CompilationVariant | undefined {
		const info = this.configuration.getDefaultCompilationSettings(file);
		if (!info) {
			return undefined;
		}
		const backend = this.toolchainRegistry.findToolchainByDisplayName(info.toolchain);
		if (!backend) {
			return undefined;
		}
		return {
			id: `default:${file.toString()}`,
			provider: 'default',
			source: file,
			toolchainProfileId: backend.profile.id,
			workingDirectory: info.workingDirectory ?? workspace.getWorkspaceFolder(file)?.uri.fsPath ?? path.dirname(file.fsPath),
			arguments: info.args,
			environment: info.env ?? {},
			displayLabel: `Default (${backend.profile.displayName})`,
		};
	}

	private variantsSources(): Uri[] {
		return [...this.variants.getAllSources()];
	}

	private selectionKey(file: Uri): string {
		return `coglens.variant.${file.toString()}`;
	}
}

function toolErrorOutput(error: unknown): { stdout: string; stderr: string } {
	if (error instanceof ToolExitError) {
		return { stdout: error.stdout, stderr: error.stderr };
	}
	if (error && typeof error === 'object') {
		const processError = error as { stderr?: unknown; stdout?: unknown };
		return {
			stdout: typeof processError.stdout === 'string' ? processError.stdout : '',
			stderr: typeof processError.stderr === 'string' ? processError.stderr : '',
		};
	}
	return { stdout: '', stderr: '' };
}
