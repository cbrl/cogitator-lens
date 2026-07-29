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
	ArtifactKind,
	ArtifactOptionId,
	ArtifactOptions,
	ArtifactProductionResult,
	ArtifactRequest,
	CompilationVariant,
	ProviderSnapshot,
	RawArtifact,
	RenderedArtifact,
	SourceState,
} from '../types/index.js';
import {
	artifactOptionsEqual,
	CompilationError,
	immutableArtifactOptions,
	productionKey,
} from '../types/index.js';
import { ToolExitError } from '../toolchains/toolchain-backend.js';
import { ExecError, ToolExecutionGate } from '../tool-execution.js';
import {
	artifactDefinitions,
	defaultOptionsFor,
	supportedArtifactKinds,
} from '../artifacts/artifact-definitions.js';
import { resolveArtifactAvailability } from '../toolchains/toolchain-map.js';
import { ToolchainRegistry } from './toolchain-registry.js';
import { CompilationConfigDatabase } from './compilation-config.js';
import { CompilationSemaphore } from './compilation-semaphore.js';
import { parseToolDiagnostics } from '../diagnostics.js';
import * as logger from '../logger.js';

export class CompilationService implements ICompilationService {
	readonly toolchainRegistry: ToolchainRegistry;
	private readonly variants = new CompilationConfigDatabase();
	private readonly changeEmitter = new EventEmitter<readonly Uri[]>();
	private readonly artifactOptionsChangeEmitter = new EventEmitter<ArtifactKind>();
	private readonly subscriptions: Disposable[] = [];
	private readonly semaphore = new CompilationSemaphore(2, () => new CancellationError());
	private readonly rawArtifactCache = new Map<string, RawArtifact>();
	private readonly currentArtifactOptions = new Map<ArtifactKind, ArtifactOptions>();

	readonly onVariantsChanged: Event<readonly Uri[]> = this.changeEmitter.event;
	readonly onArtifactOptionsChanged: Event<ArtifactKind> = this.artifactOptionsChangeEmitter.event;

	constructor(
		private readonly configuration: IConfigurationService,
		private readonly workspaceState?: Memento,
		execution?: ToolExecutionGate,
	) {
		this.toolchainRegistry = new ToolchainRegistry(execution);
		for (const kind of supportedArtifactKinds) {
			this.currentArtifactOptions.set(kind, configuration.getArtifactOptions(kind));
		}
		this.reloadUserConfiguration();
		this.subscriptions.push(
			configuration.onDidChange(() => this.reloadUserConfiguration()),
			this.variants.onDidChange(change => this.changeEmitter.fire(change.affectedSources)),
			this.toolchainRegistry.onDidChange(() => {
				this.rawArtifactCache.clear();
				this.changeEmitter.fire(this.variantsSources());
			}),
		);
	}

	getArtifactOptions(kind: ArtifactKind): ArtifactOptions {
		return this.currentArtifactOptions.get(kind)
			?? immutableArtifactOptions(defaultOptionsFor(kind));
	}

	setArtifactOption(kind: ArtifactKind, id: ArtifactOptionId, value: boolean): void {
		const current = this.getArtifactOptions(kind);
		const production = Object.hasOwn(current.production, id)
			? { ...current.production, [id]: value }
			: current.production;
		const display = Object.hasOwn(current.display, id)
			? { ...current.display, [id]: value }
			: current.display;
		const options = immutableArtifactOptions({ production, display });
		if (artifactOptionsEqual(current, options)) {
			return;
		}
		this.currentArtifactOptions.set(kind, options);
		this.artifactOptionsChangeEmitter.fire(kind);
		const folder = workspace.workspaceFolders?.[0];
		void this.configuration.updateArtifactOptions(kind, options, folder);
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

	async compile(request: ArtifactRequest): Promise<ArtifactProductionResult> {
		const { variant, artifactKind, options, cancellationToken } = request;
		if (cancellationToken.isCancellationRequested) {
			throw new CancellationError();
		}

		const source = await readSourceState(variant.source);
		if (!source.ok) {
			return {
				status: 'unavailable',
				explanation: source.explanation,
			};
		}

		const backend = this.toolchainRegistry.getToolchainById(variant.toolchainProfileId);
		if (!backend) {
			return {
				status: 'unavailable',
				explanation: `Toolchain profile not found: ${variant.toolchainProfileId}`,
			};
		}
		if (JSON.stringify(request.toolchain) !== JSON.stringify(backend.profile)) {
			return {
				status: 'unavailable',
				explanation: `Toolchain profile changed while preparing the ${artifactKind} request.`,
			};
		}
		const cell = resolveArtifactAvailability(backend.profile, artifactKind);
		if (cell.status !== 'available') {
			return cell;
		}

		const key = productionKey(request, source.value);
		const cached = this.rawArtifactCache.get(key);
		if (cached) {
			return {
				status: 'available',
				artifact: this.renderArtifact(backend, cached, options),
			};
		}

		await this.semaphore.acquire(cancellationToken);
		try {
			if (cancellationToken.isCancellationRequested) {
				throw new CancellationError();
			}

			const afterWait = this.rawArtifactCache.get(key);
			if (afterWait) {
				return {
					status: 'available',
					artifact: this.renderArtifact(backend, afterWait, options),
				};
			}

			try {
				const raw = await cell.producer(
					backend,
					variant.source,
					{
						args: [...variant.arguments, ...request.extraArguments],
						env: variant.environment,
						workingDirectory: variant.workingDirectory,
						productionOptions: options.production,
					},
					cancellationToken,
				);
				this.rawArtifactCache.set(key, raw);
				return {
					status: 'available',
					artifact: this.renderArtifact(backend, raw, options),
				};
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
					variant.source,
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
		this.rawArtifactCache.clear();
	}

	private renderArtifact(
		backend: import('../toolchains/toolchain-backend.js').ToolchainBackend,
		raw: RawArtifact,
		options: ArtifactOptions,
	): RenderedArtifact {
		try {
			return artifactDefinitions[raw.kind].renderer(raw, options.display, backend);
		} catch (error: unknown) {
			throw new CompilationError(
				error instanceof Error ? error.message : String(error),
				[],
				false,
				{ cause: error instanceof Error ? error : undefined },
			);
		}
	}

	private reloadUserConfiguration(): void {
		try {
			this.toolchainRegistry.reconcile('user', this.configuration.getToolchains());
			for (const kind of supportedArtifactKinds) {
				const options = this.configuration.getArtifactOptions(kind);
				if (!artifactOptionsEqual(this.getArtifactOptions(kind), options)) {
					this.currentArtifactOptions.set(kind, options);
					this.artifactOptionsChangeEmitter.fire(kind);
				}
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
			workingDirectory: info.workingDirectory
				?? workspace.getWorkspaceFolder(file)?.uri.fsPath
				?? path.dirname(file.fsPath),
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

async function readSourceState(
	source: Uri,
): Promise<
	| { readonly ok: true; readonly value: SourceState }
	| { readonly ok: false; readonly explanation: string }
> {
	try {
		await fs.promises.access(source.fsPath, fs.constants.R_OK);
		const stat = await fs.promises.stat(source.fsPath);
		if (!stat.isFile()) {
			return {
				ok: false,
				explanation: `Source is unavailable because it is not a readable file: ${source.fsPath}`,
			};
		}
		return {
			ok: true,
			value: { size: stat.size, mtimeMs: stat.mtimeMs },
		};
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return {
			ok: false,
			explanation: `Source is unavailable or unreadable: ${source.fsPath} (${reason})`,
		};
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
