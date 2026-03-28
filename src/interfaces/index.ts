/**
 * Core interfaces for the extension
 */

import { Uri, Event, Disposable } from 'vscode';
import { CompilerBase } from '../compiler.js';
import { CompilerInfo, CompilationInfo } from '../types/index.js';
import { ParsedAsmResult } from '../parsers/asmresult.interfaces.js';
import { ParseFiltersAndOutputOptions } from '../parsers/filters.interfaces.js';

/**
 * Registry for managing compiler instances
 */
export interface ICompilerRegistry {
	/**
	 * Get all registered compiler names
	 */
	getCompilerNames(): ReadonlyArray<string>;

	/**
	 * Get all registered compilers
	 */
	getCompilers(): ReadonlyArray<CompilerBase>;

	/**
	 * Check if a compiler with the given name exists
	 */
	hasCompiler(name: string): boolean;

	/**
	 * Get a compiler by name
	 */
	getCompiler(name: string): CompilerBase | undefined;

	/**
	 * Create and register a new compiler
	 */
	createCompiler(info: CompilerInfo): CompilerBase;

	/**
	 * Get an existing compiler or create a new one
	 */
	getOrCreateCompiler(info: CompilerInfo): CompilerBase;
}

/**
 * Service for managing compilation operations
 */
export interface ICompilationService {
	/**
	 * Access to the compiler registry
	 */
	readonly compilerRegistry: ICompilerRegistry;

	/**
	 * Global filter options for all compilations
	 */
	globalFilterOptions: ParseFiltersAndOutputOptions;

	/**
	 * Get compilation info for a file
	 */
	getCompilationInfo(file: Uri): CompilationInfo | undefined;

	/**
	 * Set compilation info for a file
	 */
	setCompilationInfo(file: Uri, info: CompilationInfo): void;

	/**
	 * Get compilation info or the default
	 */
	getCompilationInfoOrDefault(file: Uri): [CompilationInfo, boolean];

	/**
	 * Compile a file
	 */
	compile(file: Uri): Promise<ParsedAsmResult>;
}

/**
 * Configuration service for accessing extension settings
 */
export interface IConfigurationService {
	/**
	 * Get configured compilers
	 */
	getCompilers(): CompilerInfo[];

	/**
	 * Get default compilation info
	 */
	getDefaultCompilationInfo(): CompilationInfo | undefined;

	/**
	 * Get whether to dim unused source lines
	 */
	getDimUnusedSourceLines(uri: Uri): boolean;

	/**
	 * Validate compiler info structure
	 */
	validateCompilerInfo(info: unknown): info is CompilerInfo;

	/**
	 * Validate compilation info structure
	 */
	validateCompilationInfo(info: unknown): info is CompilationInfo;
}

/**
 * Build system compilation info (without compiler name, uses path instead)
 */
export type BuildsystemCompileInfo = Omit<CompilationInfo, 'compilerName'> & {
	compilerPath: Uri;
};

/**
 * Event describing changes to compilation info
 */
export interface CompilationInfoChangeEvent {
	readonly added: ReadonlyMap<Uri, BuildsystemCompileInfo>;
	readonly updated: ReadonlyMap<Uri, BuildsystemCompileInfo>;
	readonly removed: ReadonlySet<Uri>;
}

/**
 * Monitor for build system changes
 */
export interface IBuildSystemMonitor extends Disposable {
	/**
	 * Name of the build system
	 */
	readonly name: string;

	/**
	 * Initialize the monitor
	 */
	initialize(): Promise<void>;

	/**
	 * Refresh build system information
	 */
	refresh(): Promise<void>;

	/**
	 * Event fired when compilation info changes
	 */
	readonly onCompilationInfoChanged: Event<[Uri, BuildsystemCompileInfo][]>;
}
