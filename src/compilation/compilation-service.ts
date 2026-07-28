import {
	CancellationError,
	CancellationToken,
	Disposable,
	Event,
	EventEmitter,
	Memento,
	Uri,
	workspace,
} from 'vscode';
import path from 'path';
import type { ICompilationService, IConfigurationService } from '../interfaces/index.js';
import type {
	CompilationVariant,
	CompileArtifact,
	ProviderSnapshot,
} from '../types/index.js';
import type { ParseFiltersAndOutputOptions } from '../parsers/filters.interfaces.js';
import { CompilerExitError } from '../compiler.js';
import { CompilerRegistry } from './compiler-registry.js';
import { CompilationConfigDatabase } from './compilation-config.js';
import { CompilationSemaphore } from './compilation-semaphore.js';
import { parseCompilerDiagnostics } from '../diagnostics.js';
import * as logger from '../logger.js';

export class CompilationService implements ICompilationService {
	readonly compilerRegistry = new CompilerRegistry();
	private readonly variants = new CompilationConfigDatabase();
	private readonly changeEmitter = new EventEmitter<readonly Uri[]>();
	private readonly filterChangeEmitter = new EventEmitter<void>();
	private readonly subscriptions: Disposable[] = [];
	private readonly semaphore = new CompilationSemaphore(2, () => new CancellationError());
	private filters: ParseFiltersAndOutputOptions;

	readonly onVariantsChanged: Event<readonly Uri[]> = this.changeEmitter.event;
	readonly onFiltersChanged: Event<void> = this.filterChangeEmitter.event;

	constructor(
		private readonly configuration: IConfigurationService,
		private readonly workspaceState?: Memento,
	) {
		this.filters = configuration.getFilters();
		this.reloadUserConfiguration();
		this.subscriptions.push(
			configuration.onDidChange(() => this.reloadUserConfiguration()),
			this.variants.onDidChange(change => this.changeEmitter.fire(change.affectedSources)),
			this.compilerRegistry.onDidChange(() => this.changeEmitter.fire(this.variantsSources())),
		);
	}

	get globalFilterOptions(): ParseFiltersAndOutputOptions {
		return { ...this.filters };
	}

	set globalFilterOptions(value: ParseFiltersAndOutputOptions) {
		if (filtersEqual(this.filters, value)) {
			return;
		}
		this.filters = { ...value };
		this.filterChangeEmitter.fire();
		const folder = workspace.workspaceFolders?.[0];
		void this.configuration.updateFilters(this.filters, folder);
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
		this.compilerRegistry.reconcile(snapshot.provider, snapshot.compilerProfiles);
		this.variants.reconcile(snapshot.provider, snapshot.variants);
		const sources = new Map(snapshot.variants.map(variant => [variant.source.toString(), variant.source]));
		for (const source of sources.values()) {
			const persisted = this.workspaceState?.get<string>(this.selectionKey(source));
			if (persisted) {
				this.variants.selectVariant(source, persisted);
			}
		}
	}

	async compile(file: Uri, cancellationToken: CancellationToken): Promise<CompileArtifact> {
		await this.semaphore.acquire(cancellationToken);
		try {
			if (cancellationToken.isCancellationRequested) {
				throw new CancellationError();
			}
			const variant = this.getSelectedVariant(file);
			if (!variant) {
				throw new Error(`No compilation variant is configured for ${file.fsPath}`);
			}
			const compiler = this.compilerRegistry.getCompilerById(variant.compilerProfileId);
			if (!compiler) {
				throw new Error(`Compiler profile not found: ${variant.compilerProfileId}`);
			}

			try {
				const run = await compiler.compile(file.fsPath, {
					args: variant.arguments,
					defines: variant.defines,
					includes: variant.includes,
					env: variant.environment,
					workingDirectory: variant.workingDirectory,
				}, this.filters, cancellationToken);
				return {
					result: run.parsed,
					diagnostics: parseCompilerDiagnostics(
						`${run.stderr}\n${run.stdout}`,
						file,
						variant.workingDirectory,
					),
					durationMs: run.durationMs,
					command: run.command,
					truncated: false,
				};
			} catch (error) {
				if (error instanceof CompilerExitError) {
					const diagnostics = parseCompilerDiagnostics(
						`${error.stderr}\n${error.stdout}`,
						file,
						variant.workingDirectory,
					);
					Object.assign(error, { diagnostics });
				} else if (error && typeof error === 'object') {
					const processError = error as { stderr?: unknown; stdout?: unknown };
					const diagnostics = parseCompilerDiagnostics(
						`${typeof processError.stderr === 'string' ? processError.stderr : ''}\n`
						+ `${typeof processError.stdout === 'string' ? processError.stdout : ''}`,
						file,
						variant.workingDirectory,
					);
					Object.assign(error, { diagnostics });
				}
				throw error;
			}
		} finally {
			this.semaphore.release();
		}
	}

	dispose(): void {
		this.subscriptions.forEach(subscription => subscription.dispose());
		this.changeEmitter.dispose();
		this.filterChangeEmitter.dispose();
		this.variants.dispose();
		this.compilerRegistry.dispose();
	}

	private reloadUserConfiguration(): void {
		try {
			this.compilerRegistry.reconcile('user', this.configuration.getCompilers());
			const filters = this.configuration.getFilters();
			if (!filtersEqual(this.filters, filters)) {
				this.filters = filters;
				this.filterChangeEmitter.fire();
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
		const compiler = this.compilerRegistry.findCompilerByDisplayName(info.compiler);
		if (!compiler) {
			return undefined;
		}
		return {
			id: `default:${file.toString()}`,
			provider: 'default',
			source: file,
			compilerProfileId: compiler.profile.id,
			workingDirectory: info.workingDirectory ?? workspace.getWorkspaceFolder(file)?.uri.fsPath ?? path.dirname(file.fsPath),
			arguments: info.args,
			includes: info.includes,
			defines: info.defines,
			environment: info.env ?? {},
			displayLabel: `Default (${compiler.profile.displayName})`,
		};
	}

	private variantsSources(): Uri[] {
		return [...this.variants.getAllSources()];
	}

	private selectionKey(file: Uri): string {
		return `coglens.variant.${file.toString()}`;
	}
}

function filtersEqual(
	left: ParseFiltersAndOutputOptions,
	right: ParseFiltersAndOutputOptions,
): boolean {
	const keys = new Set([
		...Object.keys(left),
		...Object.keys(right),
	] as Array<keyof ParseFiltersAndOutputOptions>);
	for (const key of keys) {
		if (left[key] !== right[key]) {
			return false;
		}
	}
	return true;
}
