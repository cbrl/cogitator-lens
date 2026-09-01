import { CancellationError, Disposable, Event, EventEmitter, Memento, Uri, workspace } from 'vscode';
import fs from 'fs';
import path from 'path';
import type { ConfigurationService } from '../services/configuration-service.js';
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
import type { ArtifactRenderContext } from '../artifacts/core/artifact-definitions.js';
import {
	artifactOptionsEqual,
	CompilationError,
	immutableArtifactOptions,
	invocationDetails,
	productionKey,
	UnsupportedToolVersionError,
} from '../types/index.js';
import { ToolExitError } from '../toolchains/toolchain-backend.js';
import { ExecError } from '../exec.js';
import { artifactDefinitions, supportedArtifactKinds } from '../artifacts/core/artifact-definitions.js';
import { resolveArtifactOutput, type ToolchainArtifactOutput } from '../toolchains/toolchain-map.js';
import { ToolchainRegistry } from './toolchain-registry.js';
import { CompilationConfigDatabase } from './compilation-config.js';
import { parseToolDiagnostics } from '../diagnostics.js';
import { resolveArtifactPreset, type ArtifactPreset } from '../artifacts/ui/presets.js';
import { validateArtifactInputs } from './artifact-inputs.js';
import { RawArtifactCache } from './raw-artifact-cache.js';

export class CompilationService {
	readonly toolchainRegistry: ToolchainRegistry;
	private readonly variants = new CompilationConfigDatabase();
	private readonly changeEmitter = new EventEmitter<readonly Uri[]>();
	private readonly artifactOptionsChangeEmitter = new EventEmitter<ArtifactKind>();
	private readonly subscriptions: Disposable[] = [];
	private readonly rawArtifactCache = new RawArtifactCache();
	private readonly currentArtifactOptions = new Map<ArtifactKind, ArtifactOptions>();

	readonly onVariantsChanged: Event<readonly Uri[]> = this.changeEmitter.event;
	readonly onArtifactOptionsChanged: Event<ArtifactKind> = this.artifactOptionsChangeEmitter.event;

	constructor(
		private readonly configuration: ConfigurationService,
		private readonly workspaceState?: Memento,
	) {
		this.toolchainRegistry = new ToolchainRegistry();
		for (const kind of supportedArtifactKinds) {
			this.currentArtifactOptions.set(kind, configuration.getArtifactOptions(kind));
		}
		this.reloadUserConfiguration();
		const inputWatcher = workspace.createFileSystemWatcher('**/*');
		this.subscriptions.push(
			configuration.onDidChange(() => this.reloadUserConfiguration()),
			this.variants.onDidChange((sources) => this.changeEmitter.fire(sources)),
			this.toolchainRegistry.onDidChange(() => {
				this.rawArtifactCache.clear();
				this.changeEmitter.fire(this.variantsSources());
			}),
			inputWatcher,
			inputWatcher.onDidChange((uri) => this.handleInputChange(uri)),
			inputWatcher.onDidDelete((uri) => this.handleInputChange(uri)),
			inputWatcher.onDidCreate((uri) => this.handleInputChange(uri)),
		);
	}

	getArtifactOptions(kind: ArtifactKind): ArtifactOptions {
		// The constructor pre-fills every supported kind, so this entry always exists.
		return this.currentArtifactOptions.get(kind)!;
	}

	getArtifactPreset(kind: ArtifactKind, id: string, scope?: Uri): ArtifactPreset | undefined {
		return resolveArtifactPreset(id, this.configuration.getArtifactPresets(scope), kind);
	}

	setArtifactOption(kind: ArtifactKind, id: ArtifactOptionId, value: boolean): void {
		const current = this.getArtifactOptions(kind);
		const production = Object.hasOwn(current.production, id)
			? { ...current.production, [id]: value }
			: current.production;
		const display = Object.hasOwn(current.display, id) ? { ...current.display, [id]: value } : current.display;
		const options = immutableArtifactOptions({ production, display });
		if (artifactOptionsEqual(current, options)) {
			return;
		}
		this.currentArtifactOptions.set(kind, options);
		this.artifactOptionsChangeEmitter.fire(kind);
		// Artifact options are currently global per kind, not scoped to a workspace folder.
		void this.configuration.updateArtifactOptions(kind, options);
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
		this.variants.reconcile(
			snapshot.provider,
			snapshot.variants.map((variant) => ({
				...variant,
				toolchainProfileId: ToolchainRegistry.profileId(snapshot.provider, variant.toolchainProfileId),
			})),
		);
		const sources = new Map(snapshot.variants.map((variant) => [variant.source.toString(), variant.source]));
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

		const source = await readSourceSnapshot(variant.source);
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
		const cell = resolveArtifactOutput(backend.profile, artifactKind, request.artifactOutputId);
		if (cell.status !== 'available') {
			return cell;
		}

		const key = productionKey(request, source.value.state);
		const renderContext: ArtifactRenderContext = {
			backend,
			...(request.artifactOutputId ? { artifactOutput: cell as ToolchainArtifactOutput } : {}),
			source: {
				uri: variant.source,
				text: source.value.text,
			},
		};
		const cached = this.rawArtifactCache.get(key);
		if (cached && (await validateArtifactInputs(cached.inputs))) {
			request.onInvocation?.(invocationDetails(cached.command));
			return {
				status: 'available',
				artifact: await this.renderArtifact(cached, options, renderContext, cell.renderer, cell.listingSyntax),
			};
		} else if (cached) {
			this.rawArtifactCache.delete(key);
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
					onInvocation: request.onInvocation,
				},
				cancellationToken,
			);
			this.rawArtifactCache.set(key, raw, variant.source);
			return {
				status: 'available',
				artifact: await this.renderArtifact(raw, options, renderContext, cell.renderer, cell.listingSyntax),
			};
		} catch (error: unknown) {
			if (error instanceof CancellationError || cancellationToken.isCancellationRequested) {
				throw new CancellationError();
			}
			if (error instanceof CompilationError) {
				throw error;
			}
			if (error instanceof UnsupportedToolVersionError) {
				return {
					status: 'unavailable',
					explanation: error.message,
				};
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
	}

	dispose(): void {
		this.subscriptions.forEach((subscription) => subscription.dispose());
		this.changeEmitter.dispose();
		this.artifactOptionsChangeEmitter.dispose();
		this.variants.dispose();
		this.toolchainRegistry.dispose();
		this.rawArtifactCache.clear();
	}

	private async renderArtifact(
		raw: RawArtifact,
		options: ArtifactOptions,
		context: ArtifactRenderContext,
		outputRenderer?: import('../artifacts/core/artifact-definitions.js').ArtifactRenderer,
		listingSyntax?: import('../artifacts/core/artifact-definitions.js').ArtifactListingSyntax,
	): Promise<RenderedArtifact> {
		const renderer =
			outputRenderer ?? context.backend.getArtifactRenderer(raw.kind) ?? artifactDefinitions[raw.kind].renderer;
		const rendered = await renderer(raw, options.display, context);
		if (rendered.presentation !== 'text') {
			return rendered;
		}
		const resolvedSyntax = listingSyntax ?? artifactDefinitions[raw.kind].listingSyntax;
		return resolvedSyntax ? { ...rendered, listingSyntax: resolvedSyntax } : rendered;
	}

	private reloadUserConfiguration(): void {
		this.toolchainRegistry.reconcile('user', this.configuration.getToolchains());
		this.variants.reconcile(
			'manual',
			this.configuration.getManualCompilationVariants().map((variant) => ({
				...variant,
				provider: 'manual',
				source: Uri.file(variant.source),
			})),
		);
		for (const kind of supportedArtifactKinds) {
			const options = this.configuration.getArtifactOptions(kind);
			if (!artifactOptionsEqual(this.getArtifactOptions(kind), options)) {
				this.currentArtifactOptions.set(kind, options);
				this.artifactOptionsChangeEmitter.fire(kind);
			}
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
			workingDirectory:
				info.workingDirectory ?? workspace.getWorkspaceFolder(file)?.uri.fsPath ?? path.dirname(file.fsPath),
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

	private handleInputChange(uri: Uri): void {
		const affectedSources = this.rawArtifactCache.evictInput(uri);
		if (affectedSources.length > 0) {
			this.changeEmitter.fire(affectedSources);
		}
	}
}

async function readSourceSnapshot(source: Uri): Promise<
	| {
			readonly ok: true;
			readonly value: {
				readonly state: SourceState;
				readonly text: string;
			};
	  }
	| { readonly ok: false; readonly explanation: string }
> {
	try {
		const [stat, text] = await Promise.all([
			fs.promises.stat(source.fsPath),
			fs.promises.readFile(source.fsPath, 'utf8'),
		]);
		if (!stat.isFile()) {
			return {
				ok: false,
				explanation: `Source is unavailable because it is not a readable file: ${source.fsPath}`,
			};
		}
		return {
			ok: true,
			value: {
				state: { size: stat.size, mtimeMs: stat.mtimeMs },
				text,
			},
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
	if (error instanceof ToolExitError || error instanceof ExecError) {
		return { stdout: error.stdout, stderr: error.stderr };
	}
	return { stdout: '', stderr: '' };
}
