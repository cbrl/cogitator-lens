import { CancellationError, Disposable, Event, EventEmitter, Memento, RelativePattern, Uri, workspace } from 'vscode';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';
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
	SourceState,
	ToolchainProfile,
} from '../types/index.js';
import type { ArtifactRenderContext } from '../artifacts/core/artifact-contracts.js';
import {
	artifactOptionsEqual,
	CompilationError,
	immutableArtifactOptions,
	productionKey,
	UnsupportedToolVersionError,
} from '../types/index.js';
import { ToolExitError } from '../toolchains/toolchain-backend.js';
import { ExecError } from '../exec.js';
import { supportedArtifactKinds } from '../artifacts/core/artifact-definitions.js';
import { resolveArtifactImplementation } from '../toolchains/toolchain-artifacts.js';
import { ToolchainRegistry } from './toolchain-registry.js';
import { CompilationConfigDatabase } from './compilation-config.js';
import { resolveArtifactPreset, type ArtifactPreset } from '../artifacts/ui/presets.js';
import { artifactInputComparisonKey, validateArtifactInputs } from './artifact-inputs.js';
import { RawArtifactCache } from './raw-artifact-cache.js';
import { renderArtifact } from './artifact-rendering.js';
import { withoutTerminalEscapes } from '../diagnostics.js';
import { localFileComparisonKey, sourceUriComparisonKey, uriComparisonKey } from '../file-identity.js';
import { getToolchainDefinition } from '../toolchains/toolchain-map.js';
import type { ConfigurationOrigin } from '../buildsystems/variant-provider.js';

/** Toolchains that can compile any file of their languages, so they stand in for missing variants. */
const fallbackToolchainOrigins: readonly ConfigurationOrigin[] = ['user', 'path'];

/** How long a request waits for the first provider results before it uses what is known. */
const providerReadyTimeoutMs = 10_000;

export class CompilationService {
	readonly toolchainRegistry: ToolchainRegistry;
	private readonly variants = new CompilationConfigDatabase();
	private readonly changeEmitter = new EventEmitter<readonly Uri[]>();
	private readonly artifactOptionsChangeEmitter = new EventEmitter<ArtifactKind>();
	private readonly variantSelectionEmitter = new EventEmitter<Uri>();
	private readonly subscriptions: Disposable[] = [];
	private readonly rawArtifactCache = new RawArtifactCache();
	private readonly inputWatchers = new Map<string, Disposable>();
	private readonly currentArtifactOptions = new Map<ArtifactKind, ArtifactOptions>();
	private providersReady: Promise<void> = Promise.resolve();
	private providersSettled = true;

	readonly onVariantsChanged: Event<readonly Uri[]> = this.changeEmitter.event;
	readonly onArtifactOptionsChanged: Event<ArtifactKind> = this.artifactOptionsChangeEmitter.event;
	readonly onVariantSelectionChanged: Event<Uri> = this.variantSelectionEmitter.event;

	constructor(
		private readonly configuration: ConfigurationService,
		private readonly workspaceState?: Memento,
	) {
		this.toolchainRegistry = new ToolchainRegistry();
		for (const kind of supportedArtifactKinds) {
			this.currentArtifactOptions.set(kind, configuration.getArtifactOptions(kind));
		}
		this.reloadUserConfiguration();
		this.subscriptions.push(
			configuration.onDidChange(() => this.reloadUserConfiguration()),
			this.variants.onDidChange((sources) => this.changeEmitter.fire(sources)),
			this.variants.onDidSelect((source) => this.variantSelectionEmitter.fire(source)),
			this.toolchainRegistry.onDidChange(() => {
				this.rawArtifactCache.clear();
				this.syncInputWatchers();
				this.changeEmitter.fire(this.variantsSources());
			}),
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

	/** Returns the discovered variants of a file, or its fallback variants when nothing describes it. */
	getVariants(file: Uri): readonly CompilationVariant[] {
		const variants = this.variants.getVariants(file);
		return variants.length > 0 ? variants : this.fallbackVariants(file);
	}

	/** Finds a variant by ID, including a fallback variant that a newer discovery has since replaced. */
	findVariant(file: Uri, variantId: string): CompilationVariant | undefined {
		return (
			this.variants.getVariants(file).find((variant) => variant.id === variantId) ??
			this.fallbackVariants(file, { forLookup: true }).find((variant) => variant.id === variantId)
		);
	}

	getAllSources(): readonly Uri[] {
		return this.variants.getAllSources();
	}

	getSelectedVariant(file: Uri): CompilationVariant | undefined {
		const discovered = this.variants.getSelectedVariant(file);
		if (discovered) {
			return discovered;
		}
		const fallbacks = this.fallbackVariants(file);
		const persisted = this.workspaceState?.get<string>(this.selectionKey(file));
		return fallbacks.find((variant) => variant.id === persisted) ?? fallbacks[0];
	}

	/** Whether several discovered variants describe a file and none has been chosen. Fallbacks never ask. */
	needsVariantChoice(file: Uri): boolean {
		return this.variants.getVariants(file).length > 1 && !this.variants.hasSelectedVariant(file);
	}

	async selectVariant(file: Uri, variantId: string): Promise<boolean> {
		const selected = this.variants.selectVariant(file, variantId) || this.selectFallbackVariant(file, variantId);
		if (selected) {
			await this.workspaceState?.update(this.selectionKey(file), variantId);
		}
		return selected;
	}

	/** Records the initialization of the variant providers, so requests can wait for their first results. */
	trackProviderInitialization(initialization: Promise<unknown>): void {
		this.providersSettled = false;
		const ready = initialization.then(
			() => undefined,
			() => undefined,
		);
		this.providersReady = ready;
		void ready.then(() => {
			if (this.providersReady === ready) {
				this.providersSettled = true;
			}
		});
	}

	/** Whether the variant providers have published their first results. */
	get providersAreReady(): boolean {
		return this.providersSettled;
	}

	/**
	 * Waits until the variant providers have published their first results, or until the timeout.
	 * Before that, a file in a compilation database could otherwise resolve to a fallback variant.
	 */
	whenProvidersReady(timeoutMs = providerReadyTimeoutMs): Promise<void> {
		let timeout: ReturnType<typeof setTimeout> | undefined;
		return Promise.race([
			this.providersReady,
			new Promise<void>((resolve) => {
				timeout = setTimeout(resolve, timeoutMs);
			}),
		]).finally(() => clearTimeout(timeout));
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
		const sources = new Map(
			snapshot.variants.map((variant) => [sourceUriComparisonKey(variant.source), variant.source]),
		);
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
		const resolved = resolveArtifactImplementation(backend.profile, artifactKind, request.artifactOutputId);
		if (resolved.status !== 'available') {
			return resolved;
		}
		const { implementation } = resolved;

		const key = productionKey(request, source.value.state);
		const renderContext: ArtifactRenderContext = {
			backend,
			source: {
				uri: variant.source,
				text: source.value.text,
			},
		};
		const cached = this.rawArtifactCache.get(key);
		if (cached && (await validateArtifactInputs(cached.inputs))) {
			request.onInvocation?.(cached.command);
			return {
				status: 'available',
				artifact: await renderArtifact(cached, implementation, options, renderContext),
			};
		} else if (cached) {
			this.rawArtifactCache.delete(key);
			this.syncInputWatchers();
		}

		try {
			const produced = await implementation.producer(
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
			const raw: RawArtifact = { ...produced, kind: artifactKind };
			this.rawArtifactCache.set(key, raw, variant.source);
			this.syncInputWatchers();
			return {
				status: 'available',
				artifact: await renderArtifact(raw, implementation, options, renderContext),
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
			const diagnostics = backend.definition.parseDiagnostics(
				withoutTerminalEscapes(`${output.stderr}\n${output.stdout}`),
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
		this.inputWatchers.forEach((watcher) => watcher.dispose());
		this.inputWatchers.clear();
		this.changeEmitter.dispose();
		this.artifactOptionsChangeEmitter.dispose();
		this.variantSelectionEmitter.dispose();
		this.variants.dispose();
		this.toolchainRegistry.dispose();
		this.rawArtifactCache.clear();
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

	/**
	 * Variants for a file that no provider describes: the configured default invocation, then the
	 * toolchains that compile the file's language.
	 *
	 * `forLookup` includes every workspace and PATH toolchain, so an open artifact still finds its
	 * variant while its source is closed, or after a workspace override or default hides it.
	 */
	private fallbackVariants(
		file: Uri,
		{ forLookup = false }: { readonly forLookup?: boolean } = {},
	): CompilationVariant[] {
		const defaultVariant = this.createDefaultVariant(file);
		const profiles = forLookup ? this.fallbackToolchains() : this.languageToolchains(file, defaultVariant);
		return [
			...(defaultVariant ? [defaultVariant] : []),
			...profiles.map((profile) => this.createToolchainVariant(file, profile)),
		];
	}

	private fallbackToolchains(): ToolchainProfile[] {
		return fallbackToolchainOrigins.flatMap((origin) => this.toolchainRegistry.getProfiles(origin));
	}

	/**
	 * The workspace and PATH toolchains for the language of the open document, in that order. The
	 * default invocation's toolchain and a PATH toolchain that duplicates a workspace one are left out.
	 */
	private languageToolchains(file: Uri, defaultVariant: CompilationVariant | undefined): ToolchainProfile[] {
		const languageId = openDocumentLanguage(file);
		if (!languageId) {
			return [];
		}
		const userExecutables = new Set(
			this.toolchainRegistry.getProfiles('user').map((profile) => localFileComparisonKey(profile.executable)),
		);
		return this.fallbackToolchains().filter(
			(profile) =>
				profile.id !== defaultVariant?.toolchainProfileId &&
				getToolchainDefinition(profile.kind).languageIdentifiers.includes(languageId) &&
				(this.toolchainRegistry.getOrigin(profile.id) === 'user' ||
					!userExecutables.has(localFileComparisonKey(profile.executable))),
		);
	}

	private selectFallbackVariant(file: Uri, variantId: string): boolean {
		if (
			this.variants.getVariants(file).length > 0 ||
			!this.fallbackVariants(file).some((variant) => variant.id === variantId)
		) {
			return false;
		}
		this.variantSelectionEmitter.fire(file);
		return true;
	}

	private createToolchainVariant(file: Uri, profile: ToolchainProfile): CompilationVariant {
		const detected = this.toolchainRegistry.getOrigin(profile.id) === 'path';
		return {
			id: `toolchain:${profile.id}|${sourceUriComparisonKey(file)}`,
			provider: 'default',
			source: file,
			toolchainProfileId: profile.id,
			workingDirectory: workspace.getWorkspaceFolder(file)?.uri.fsPath ?? path.dirname(file.fsPath),
			arguments: [],
			environment: {},
			displayLabel: detected ? `${profile.displayName} (PATH)` : profile.displayName,
		};
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
			id: `default:${sourceUriComparisonKey(file)}`,
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
		return `coglens.variant.${sourceUriComparisonKey(file)}`;
	}

	private handleInputChange(inputKey: string): void {
		const affectedSources = this.rawArtifactCache.evictInputKey(inputKey);
		this.syncInputWatchers();
		if (affectedSources.length > 0) {
			this.changeEmitter.fire(affectedSources);
		}
	}

	private syncInputWatchers(): void {
		const inputs = new Map(
			this.rawArtifactCache.getInputUris().map((uri) => [artifactInputComparisonKey(uri), uri] as const),
		);
		for (const [key, watcher] of this.inputWatchers) {
			if (!inputs.has(key)) {
				watcher.dispose();
				this.inputWatchers.delete(key);
			}
		}
		for (const [key, inputUri] of inputs) {
			if (this.inputWatchers.has(key)) {
				continue;
			}
			let inputPath: string;
			try {
				inputPath = fileURLToPath(inputUri);
			} catch {
				continue;
			}
			const watcher = workspace.createFileSystemWatcher(
				new RelativePattern(Uri.file(path.dirname(inputPath)), path.basename(inputPath)),
			);
			this.inputWatchers.set(
				key,
				Disposable.from(
					watcher,
					watcher.onDidChange(() => this.handleInputChange(key)),
					watcher.onDidDelete(() => this.handleInputChange(key)),
					watcher.onDidCreate(() => this.handleInputChange(key)),
				),
			);
		}
	}
}

/** The language of the open document for a file, which decides the toolchains that can compile it. */
function openDocumentLanguage(file: Uri): string | undefined {
	const documents = workspace.textDocuments.filter((document) => document.uri.scheme === 'file');
	const key = uriComparisonKey(file);
	const exact = documents.find((candidate) => uriComparisonKey(candidate.uri) === key);
	if (exact) {
		return exact.languageId;
	}
	// The same file reached through a symlink.
	const sourceKey = sourceUriComparisonKey(file);
	return documents.find((candidate) => sourceUriComparisonKey(candidate.uri) === sourceKey)?.languageId;
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

const maximumFailureOutputLength = 20_000;

/**
 * The failure message followed by the tool's own output. Compilers report most errors there, and
 * the message alone only names the exit code.
 */
export function failureDetails(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const output = toolErrorOutput(error instanceof Error ? error.cause : undefined);
	const clip = (text: string): string =>
		text.length > maximumFailureOutputLength ? `${text.slice(0, maximumFailureOutputLength)}\n…` : text;
	return [
		message,
		clip(withoutTerminalEscapes(output.stderr).trim()),
		clip(withoutTerminalEscapes(output.stdout).trim()),
	]
		.filter(Boolean)
		.join('\n\n');
}

function toolErrorOutput(error: unknown): { stdout: string; stderr: string } {
	if (error instanceof ToolExitError || error instanceof ExecError) {
		return { stdout: error.stdout, stderr: error.stderr };
	}
	return { stdout: '', stderr: '' };
}
