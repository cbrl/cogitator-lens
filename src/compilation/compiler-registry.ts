/**
 * Compiler registry for managing compiler instances
 */

import { CompilerBase } from '../compiler.js';
import { CompilerInfo } from '../types/index.js';
import { ICompilerRegistry } from '../interfaces/index.js';
import { getCompilerByType } from '../compilers/compiler-map.js';

/**
 * Registry that manages compiler instances by name
 */
export class CompilerRegistry implements ICompilerRegistry {
	private cache = new Map<string, CompilerBase>();

	/**
	 * Get all registered compiler names
	 */
	getCompilerNames(): ReadonlyArray<string> {
		return Array.from(this.cache.keys());
	}

	/**
	 * Get all registered compilers
	 */
	getCompilers(): ReadonlyArray<CompilerBase> {
		return Array.from(this.cache.values());
	}

	/**
	 * Check if a compiler with the given name exists
	 */
	hasCompiler(name: string): boolean {
		return this.cache.has(name);
	}

	/**
	 * Get a compiler by name
	 */
	getCompiler(name: string): CompilerBase | undefined {
		return this.cache.get(name);
	}

	/**
	 * Create and register a new compiler
	 * @throws Error if compiler type is unknown or creation fails
	 */
	createCompiler(info: CompilerInfo): CompilerBase {
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

	/**
	 * Create multiple compilers at once
	 */
	createCompilers(infos: CompilerInfo[]): CompilerBase[] {
		return infos.map(info => this.createCompiler(info));
	}

	/**
	 * Get an existing compiler or create a new one if it doesn't exist
	 */
	getOrCreateCompiler(info: CompilerInfo): CompilerBase {
		return this.getCompiler(info.name) ?? this.createCompiler(info);
	}

	/**
	 * Get or create multiple compilers at once
	 */
	getOrCreateCompilers(infos: CompilerInfo[]): CompilerBase[] {
		return infos.map(info => this.getOrCreateCompiler(info));
	}
}
