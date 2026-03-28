/**
 * Compilation configuration database for managing file-specific compilation settings
 */

import { Uri } from 'vscode';
import { CompilationInfo } from '../types/index.js';
import { UriMap } from '../uri-containers.js';

/**
 * Database that associates files with their compilation settings
 */
export class CompilationConfigDatabase {
	private compilationInfo = new UriMap<CompilationInfo>({ ignoreFragment: true });

	private _defaultCompileInfo: CompilationInfo = {
		compilerName: '',
		defines: [],
		includes: [],
		args: [],
	};

	/**
	 * Get the default compilation info used for files without specific settings
	 */
	get defaultCompileInfo(): CompilationInfo {
		return this._defaultCompileInfo;
	}

	/**
	 * Set the default compilation info
	 */
	set defaultCompileInfo(info: CompilationInfo) {
		this._defaultCompileInfo = info;
	}

	/**
	 * Get compilation info for a specific file
	 */
	getCompilationInfo(file: Uri): CompilationInfo | undefined {
		return this.compilationInfo.get(file);
	}

	/**
	 * Get compilation info for a file, or return default if not found
	 * @returns Tuple of [info, wasFound] where wasFound indicates if file-specific info exists
	 */
	getCompilationInfoOrDefault(file: Uri): [CompilationInfo, boolean] {
		const info = this.compilationInfo.get(file);
		return [info ?? this._defaultCompileInfo, info !== undefined];
	}

	/**
	 * Set compilation info for a specific file
	 */
	setCompilationInfo(file: Uri, info: CompilationInfo): void {
		this.compilationInfo.set(file, info);
	}

	/**
	 * Remove compilation info for a specific file
	 */
	removeCompilationInfo(file: Uri): boolean {
		return this.compilationInfo.delete(file);
	}

	/**
	 * Check if a file has specific compilation info
	 */
	hasCompilationInfo(file: Uri): boolean {
		return this.compilationInfo.has(file);
	}

	/**
	 * Get all files with compilation info
	 */
	getAllFiles(): ReadonlyArray<Uri> {
		return Array.from(this.compilationInfo.keys());
	}

	/**
	 * Clear all compilation info
	 */
	clear(): void {
		this.compilationInfo.clear();
	}
}
