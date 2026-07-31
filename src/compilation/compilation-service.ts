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
import type { ArtifactRenderContext } from '../artifacts/artifact-definitions.js';
import {
	artifactOptionsEqual,
	CompilationError,
	immutableArtifactOptions,
	productionKey,
	UnsupportedToolVersionError,
} from '../types/index.js';
import { ToolExitError } from '../toolchains/toolchain-backend.js';
import { ExecError } from '../exec.js';
import {
	artifactDefinitions,
	supportedArtifactKinds,
} from '../artifacts/artifact-definitions.js';
import { resolveArtifactAvailability } from '../toolchains/toolchain-map.js';
import { ToolchainRegistry } from './toolchain-registry.js';
import { CompilationConfigDatabase } from './compilation-config.js';
import { parseToolDiagnostics } from '../diagnostics.js';
import {
	resolveArtifactPreset,
	type ArtifactPreset,
} from '../artifacts/presets.js';
import {
	artifactInputComparisonKey,
	validateArtifactInputs,
} from './artifact-inputs.js';
import { pathToFileURL } from 'node:url';

export class CompilationService {
	readonly toolchainRegistry: ToolchainRegistry;
	private readonly variants = new CompilationConfigDatabase();
	private readonly changeEmitter = new EventEmitter<readonly Uri[]>();
	private readonly artifactOptionsChangeEmitter = new EventEmitter<ArtifactKind>();
	private readonly subscriptions: Disposable[] = [];
	private readonly rawArtifactCache = new Map<string, RawArtifact>();
	private readonly inputToRawCacheKeys = new Map<string, Set<string>>();
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
			this.variants.onDidChange(sources => this.changeEmitter.fire(sources)),
			this.toolchainRegistry.onDidChange(() => {
				this.clearRawArtifactCache();
				this.changeEmitter.fire(this.variantsSources());
			}),
			inputWatcher,
			inputWatcher.onDidChange(uri => this.evictInput(uri)),
			inputWatcher.onDidDelete(uri => this.evictInput(uri)),
			inputWatcher.onDidCreate(uri => this.evictInput(uri)),
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
		const cell = resolveArtifactAvailability(backend.profile, artifactKind);
		if (cell.status !== 'available') {
			return cell;
		}

		const key = productionKey(request, source.value.state);
		const renderContext: ArtifactRenderContext = {
			backend,
			source: {
				uri: variant.source,
				text: source.value.text,
			},
		};
		const cached = this.rawArtifactCache.get(key);
		if (cached && await validateArtifactInputs(cached.inputs)) {
			return {
				status: 'available',
				artifact: await this.renderArtifact(cached, options, renderContext),
			};
		} else if (cached) {
			this.removeRawArtifact(key);
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
			this.cacheRawArtifact(key, raw);
			return {
				status: 'available',
				artifact: await this.renderArtifact(raw, options, renderContext),
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
		this.subscriptions.forEach(subscription => subscription.dispose());
		this.changeEmitter.dispose();
		this.artifactOptionsChangeEmitter.dispose();
		this.variants.dispose();
		this.toolchainRegistry.dispose();
		this.clearRawArtifactCache();
	}

	private async renderArtifact(
		raw: RawArtifact,
		options: ArtifactOptions,
		context: ArtifactRenderContext,
	): Promise<RenderedArtifact> {
		const renderer = context.backend.getArtifactRenderer(raw.kind)
			?? artifactDefinitions[raw.kind].renderer;
		return await renderer(raw, options.display, context);
	}

	private reloadUserConfiguration(): void {
		this.toolchainRegistry.reconcile('user', this.configuration.getToolchains());
		this.variants.reconcile('manual', this.configuration.getManualCompilationVariants().map(variant => ({
			...variant,
			provider: 'manual',
			source: Uri.file(variant.source),
		})));
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

	private cacheRawArtifact(key: string, artifact: RawArtifact): void {
		this.removeRawArtifact(key);
		this.rawArtifactCache.set(key, artifact);
		for (const input of artifact.inputs) {
			const inputKey = artifactInputComparisonKey(input.uri);
			const keys = this.inputToRawCacheKeys.get(inputKey) ?? new Set<string>();
			keys.add(key);
			this.inputToRawCacheKeys.set(inputKey, keys);
		}
	}

	private removeRawArtifact(key: string): void {
		const artifact = this.rawArtifactCache.get(key);
		if (!artifact) {
			return;
		}
		this.rawArtifactCache.delete(key);
		for (const input of artifact.inputs) {
			const inputKey = artifactInputComparisonKey(input.uri);
			const keys = this.inputToRawCacheKeys.get(inputKey);
			keys?.delete(key);
			if (keys?.size === 0) {
				this.inputToRawCacheKeys.delete(inputKey);
			}
		}
	}

	private clearRawArtifactCache(): void {
		this.rawArtifactCache.clear();
		this.inputToRawCacheKeys.clear();
	}

	private evictInput(uri: Uri): void {
		const inputKey = artifactInputComparisonKey(pathToFileURL(uri.fsPath).href);
		for (const key of [...(this.inputToRawCacheKeys.get(inputKey) ?? [])]) {
			this.removeRawArtifact(key);
		}
	}
}

async function readSourceSnapshot(
	source: Uri,
): Promise<
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
