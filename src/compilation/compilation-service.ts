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
	CompileArtifact,
	CompileRequest,
	ProviderSnapshot,
} from '../types/index.js';
import { CompilationError } from '../types/index.js';
import type { ParseFiltersAndOutputOptions } from '../parsers/filters.interfaces.js';
import { CompilerExitError, type CompilerRunResult } from '../compiler.js';
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
	private readonly rawAssemblyCache = new Map<string, {
		signature: string;
		run: CompilerRunResult;
	}>();
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

	async compile(request: CompileRequest): Promise<CompileArtifact> {
		const { variant, outputMode, outputOptions, filters, cancellationToken } = request;
		const file = variant.source;
		if (cancellationToken.isCancellationRequested) {
			throw new CancellationError();
		}
		if (outputMode !== 'assembly') {
			throw new CompilationError(`Unsupported compilation output mode: ${outputMode as string}`);
		}
		const compiler = this.compilerRegistry.getCompilerById(variant.compilerProfileId);
		if (!compiler) {
			throw new CompilationError(`Compiler profile not found: ${variant.compilerProfileId}`);
		}

		const cacheKey = `${file.toString()}\0${variant.id}\0${outputMode}`;
		const signature = await this.compileSignature(variant, compiler.profile, outputOptions);
		const cached = this.rawAssemblyCache.get(cacheKey);
		if (cached?.signature === signature) {
			return this.createArtifact(compiler, cached.run, variant, filters);
		}

		await this.semaphore.acquire(cancellationToken);
		try {
			if (cancellationToken.isCancellationRequested) {
				throw new CancellationError();
			}

			try {
				const run = await compiler.compile(file.fsPath, {
					args: variant.arguments,
					defines: variant.defines,
					includes: variant.includes,
					env: variant.environment,
					workingDirectory: variant.workingDirectory,
				}, cancellationToken);
				this.rawAssemblyCache.set(cacheKey, { signature, run });
				return this.createArtifact(compiler, run, variant, filters);
			} catch (error: unknown) {
				if (error instanceof CancellationError || cancellationToken.isCancellationRequested) {
					throw new CancellationError();
				}
				if (error instanceof CompilationError) {
					throw error;
				}
				const output = compilerErrorOutput(error);
				const diagnostics = parseCompilerDiagnostics(
					`${output.stderr}\n${output.stdout}`,
					file,
					variant.workingDirectory,
				);
				const message = error instanceof Error ? error.message : String(error);
				throw new CompilationError(message, diagnostics, {
					cause: error instanceof Error ? error : undefined,
				});
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
		this.rawAssemblyCache.clear();
	}

	private createArtifact(
		compiler: import('../compiler.js').CompilerBase,
		run: CompilerRunResult,
		variant: CompilationVariant,
		filters: ParseFiltersAndOutputOptions,
	): CompileArtifact {
		let result;
		try {
			result = compiler.parseAssembly(run.rawAssembly, filters);
		} catch (error: unknown) {
			throw new CompilationError(
				error instanceof Error ? error.message : String(error),
				[],
				{ cause: error instanceof Error ? error : undefined },
			);
		}
		return {
			result,
			rawAssembly: run.rawAssembly,
			diagnostics: parseCompilerDiagnostics(
				`${run.stderr}\n${run.stdout}`,
				variant.source,
				variant.workingDirectory,
			),
			durationMs: run.durationMs,
			command: run.command,
			truncated: false,
		};
	}

	private async compileSignature(
		variant: CompilationVariant,
		profile: import('../types/index.js').CompilerProfile,
		outputOptions: import('../parsers/filters.interfaces.js').CompilerOutputOptions,
	): Promise<string> {
		let sourceState: { size: number; mtimeMs: number };
		try {
			const stat = await fs.promises.stat(variant.source.fsPath);
			sourceState = { size: stat.size, mtimeMs: stat.mtimeMs };
		} catch {
			sourceState = { size: -1, mtimeMs: -1 };
		}
		return JSON.stringify({ variant, profile, outputOptions, sourceState });
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

function compilerErrorOutput(error: unknown): { stdout: string; stderr: string } {
	if (error instanceof CompilerExitError) {
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
