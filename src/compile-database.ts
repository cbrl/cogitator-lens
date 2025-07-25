import { Uri, workspace, window } from "vscode";
import { CompilerBase, CompilerInfo, CompileOptions } from "./compiler";
import { getCompilerByType } from "./compilers/compiler-map";
import { ParsedAsmResult } from './parsers/asmresult.interfaces';
import { CompilerOutputOptions, ParseFiltersAndOutputOptions } from "./parsers/filters.interfaces";
import * as logger from "./logger";

export type CompilationInfo = {
	compilerName: string;
	defines: string[];
	includes: string[];
	args: string[];
}

// Handles creation and caching of compilers based on their ID
export class CompilerCache {
	private cache: Map<string, CompilerBase> = new Map();

	public get compilerNames(): string[] {
		return Array.from(this.cache.keys());
	}

	public get compilers(): CompilerBase[] {
		return Array.from(this.cache.values());
	}

	public hasCompiler(name: string): boolean {
		return this.cache.has(name);
	}

	public getCompiler(name: string): CompilerBase | undefined {
		return this.cache.get(name);
	}

	public createCompiler(info: CompilerInfo): CompilerBase {
		try {
			const compilerType = getCompilerByType(info.type);
			if (compilerType === undefined) {
				throw new Error(`Unknown compiler type: ${info.type}`);
			}

			const compiler = new compilerType(info);
			this.cache.set(info.name, compiler);
			return compiler;
		}
		catch (error) {
			const errorMessage = (error instanceof Error) ? error.message : JSON.stringify(error);
			throw new Error(`Failed to create compiler: ${errorMessage}`);
		}
	}

	public createCompilers(info: CompilerInfo[]): CompilerBase[] {
		return info.map(value => this.createCompiler(value));
	}

	public getOrCreateCompiler(info: CompilerInfo): CompilerBase {
		return this.getCompiler(info.name) ?? this.createCompiler(info);
	}

	public getOrCreateCompilers(info: CompilerInfo[]): CompilerBase[] {
		return info.map(value => this.getOrCreateCompiler(value));
	}
}

// Associates files with their compiler exectuables and settings
export class CompileInfoDatabase {
	private compilationInfo: Map<string, CompilationInfo> = new Map();

	public defaultCompileInfo: CompilationInfo = {
		compilerName: '',
		defines: [],
		includes: [],
		args: [],
	};

	public get info() {
		return this.compilationInfo;
	}

	public getCompilationInfo(file: Uri): CompilationInfo | undefined {
		return this.compilationInfo.get(file.fsPath);
	}

	public getCompilationInfoOrDefault(file: Uri): [CompilationInfo, boolean] {
		const info = this.compilationInfo.get(file.fsPath);
		return [info ?? this.defaultCompileInfo, info !== undefined];
	}

	public setCompilationInfo(file: Uri, info: CompilationInfo): void {
		this.compilationInfo.set(file.fsPath, info);
	}
}

export class CompileManager {
	// Maps file path to compiler info
	private _compilationInfo: CompileInfoDatabase = new CompileInfoDatabase();

	// Maps compiler names to compiler
	private _compilerCache: CompilerCache = new CompilerCache();

	// Global filter options to be used for all compilations
	private _globalFilterOptions: ParseFiltersAndOutputOptions = {
		labels: true,
		directives: true,
		commentOnly: true,
		libraryCode: false, //this can be a bit counter-intuitive if part of the user's project is a library
		dontMaskFilenames: true //filename masking is part of the Compiler Explorer code, but not very useful in this context
	};

	constructor() {
		// TODO: support multi-workspace settings?
		const scope = workspace.workspaceFolders?.at(0) ?? null;

		// Load compiler info from workspace configuration
		// TODO: handle configuration changes during runtime
		const compilers = workspace.getConfiguration('coglens', scope).get<CompilerInfo[]>('compilers') ?? [];

		for (const compiler of compilers) {
			if (!this._compilerCache.hasCompiler(compiler.name)) {
				this._compilerCache.createCompiler(compiler);
			}
			else {
				logger.logAndShowWarning(`Compiler "${compiler.name}" already exists. Skipping.`);
			}
		}

		const defaultCompileInfo = workspace.getConfiguration('coglens', scope).get<CompilationInfo>('defaultCompileInfo');

		// For whatever reason, Code exposes this behavior for default or optional return values,
		// but also tries its absolute hardest to return a value even if the user hasn't set
		// anything in the config, rendering the default/optional return behavior functionally
		// useless: https://github.com/Microsoft/vscode/issues/35451
		//
		// In this case that means it always returns an empty object if the config value isn't set.
		if (defaultCompileInfo !== undefined && Object.keys(defaultCompileInfo).length > 0) {
			this._compilationInfo.defaultCompileInfo = defaultCompileInfo;
		}
	}

	public get compilerCache(): CompilerCache {
		return this._compilerCache;
	}

	public get compilationInfo(): CompileInfoDatabase {
		return this._compilationInfo;
	}

	public setCompilationInfo(file: Uri, info: CompilationInfo): void {
		this._compilationInfo.setCompilationInfo(file, info);
	}

	public get globalFilterOptions(): ParseFiltersAndOutputOptions {
		return this._globalFilterOptions;
	}

	public set globalFilterOptions(filterOptions: ParseFiltersAndOutputOptions) {
		this._globalFilterOptions = filterOptions;
	}

	public async compile(file: Uri): Promise<ParsedAsmResult> {
		const [compilationInfo, infoFound] = this._compilationInfo.getCompilationInfoOrDefault(file);

		const compiler = this._compilerCache.getCompiler(compilationInfo.compilerName);

		if (compiler === undefined) {
			let errorMessage = `Compiler not found: ${compilationInfo.compilerName}`;

			if (!infoFound) {
				errorMessage = `(default compile info) Compiler not found: ${compilationInfo.compilerName}`;
			}

			throw new Error(errorMessage);
		}

		//const workspaceConfig = workspace.getConfiguration('', file.with({scheme: 'file'}));

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
			}
			else {
				throw error;
			}
		}
	}
}
