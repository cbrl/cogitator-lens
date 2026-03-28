/**
 * Compilation service for orchestrating the compilation process
 */

import { Disposable, Uri, workspace, Event } from 'vscode';
import { ICompilationService, IConfigurationService } from '../interfaces/index.js';
import { CompilationInfo, CompileOptions } from '../types/index.js';
import { CompilerRegistry } from './compiler-registry.js';
import { CompilationConfigDatabase } from './compilation-config.js';
import { ParsedAsmResult } from '../parsers/asmresult.interfaces.js';
import { ParseFiltersAndOutputOptions } from '../parsers/filters.interfaces.js';
import * as logger from '../logger.js';

/**
 * Service that manages the compilation process
 */
export class CompilationService implements ICompilationService {
	private static readonly MAX_CONCURRENT_COMPILATIONS = 2;

	private compilationConfig: CompilationConfigDatabase;
	private registry: CompilerRegistry;
	private configService: IConfigurationService;
	private configChangeDisposable: Disposable;

	private _globalFilterOptions: ParseFiltersAndOutputOptions = {
		labels: true,
		directives: true,
		commentOnly: true,
		libraryCode: false, // Enabling this can give counter-intuitive results if part of the user's project is a library
		dontMaskFilenames: true // Filename masking is part of the Compiler Explorer code, but not very useful in this context
	};

	private activeCompilations = 0;
	private compilationQueue: Array<{ resolve: () => void }> = [];

	constructor(configService: IConfigurationService) {
		this.compilationConfig = new CompilationConfigDatabase();
		this.registry = new CompilerRegistry();
		this.configService = configService;

		this.loadCompilersFromConfig();

		this.configChangeDisposable = workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('coglens.compilers') || e.affectsConfiguration('coglens.defaultCompileInfo')) {
				this.reloadConfiguration();
			}
		});
	}

	public dispose(): void {
		this.configChangeDisposable.dispose();
		this.compilationConfig.dispose();
	}

	private loadCompilersFromConfig(): void {
		const compilers = this.configService.getCompilers();
		for (const compilerInfo of compilers) {
			if (!this.registry.hasCompiler(compilerInfo.name)) {
				try {
					this.registry.createCompiler(compilerInfo);
				} catch (error) {
					logger.logAndShowError(`Failed to create compiler "${compilerInfo.name}": ${error}`);
				}
			} else {
				logger.logAndShowWarning(`Compiler "${compilerInfo.name}" already exists. Skipping.`);
			}
		}

		// Load default compilation info
		const defaultCompileInfo = this.configService.getDefaultCompilationInfo();
		if (defaultCompileInfo !== undefined) {
			this.compilationConfig.defaultCompileInfo = defaultCompileInfo;
		}
	}

	private reloadConfiguration(): void {
		this.registry = new CompilerRegistry();
		this.loadCompilersFromConfig();
		logger.logChannel.info('Reloaded compiler configuration');
	}

	/**
	 * Access to the compiler registry
	 */
	get compilerRegistry(): CompilerRegistry {
		return this.registry;
	}

	/**
	 * Event fired when compilation info changes for a file
	 */
	get onCompilationInfoChanged(): Event<Uri> {
		return this.compilationConfig.onDidChange;
	}

	/**
	 * Get global filter options for all compilations
	 */
	get globalFilterOptions(): ParseFiltersAndOutputOptions {
		return this._globalFilterOptions;
	}

	/**
	 * Set global filter options for all compilations
	 */
	set globalFilterOptions(options: ParseFiltersAndOutputOptions) {
		this._globalFilterOptions = options;
	}

	/**
	 * Get compilation info for a file
	 */
	getCompilationInfo(file: Uri): CompilationInfo | undefined {
		return this.compilationConfig.getCompilationInfo(file);
	}

	/**
	 * Set compilation info for a file
	 */
	setCompilationInfo(file: Uri, info: CompilationInfo): void {
		this.compilationConfig.setCompilationInfo(file, info);
	}

	/**
	 * Get compilation info or the default
	 * @returns Tuple of [info, wasFound] where wasFound indicates if file-specific info exists
	 */
	getCompilationInfoOrDefault(file: Uri): [CompilationInfo, boolean] {
		return this.compilationConfig.getCompilationInfoOrDefault(file);
	}

	/**
	 * Get all files with compilation info
	 */
	getAllFiles(): ReadonlyArray<Uri> {
		return this.compilationConfig.getAllFiles();
	}

	/**
	 * Compile a file
	 * @throws Error if compiler not found or compilation fails
	 */
	async compile(file: Uri): Promise<ParsedAsmResult> {
		await this.acquireCompilationSlot();

		try {
			return await this.doCompile(file);
		} finally {
			this.releaseCompilationSlot();
		}
	}

	private async acquireCompilationSlot(): Promise<void> {
		if (this.activeCompilations < CompilationService.MAX_CONCURRENT_COMPILATIONS) {
			this.activeCompilations++;
			return;
		}

		return new Promise<void>(resolve => {
			this.compilationQueue.push({ resolve });
		});
	}

	private releaseCompilationSlot(): void {
		const next = this.compilationQueue.shift();
		if (next) {
			next.resolve();
		} else {
			this.activeCompilations--;
		}
	}

	private async doCompile(file: Uri): Promise<ParsedAsmResult> {
		const [compilationInfo, infoFound] = this.compilationConfig.getCompilationInfoOrDefault(file);

		const compiler = this.registry.getCompiler(compilationInfo.compilerName);

		if (compiler === undefined) {
			let errorMessage = `Compiler not found: "${compilationInfo.compilerName}"`;

			if (!infoFound) {
				errorMessage = `(default compile info) Compiler not found: "${compilationInfo.compilerName}"`;
			}

			throw new Error(errorMessage);
		}

		const options: CompileOptions = {
			defines: compilationInfo.defines,
			includes: compilationInfo.includes,
			args: compilationInfo.args
		};

		try {
			const result = await compiler.compile(file.fsPath, options, this._globalFilterOptions);
			return result;
		} catch (error) {
			if (!infoFound && error instanceof Error) {
				throw new Error(`(default compile info) ${error.message}`);
			} else {
				throw error;
			}
		}
	}
}
