/**
 * Configuration service for centralized access to extension settings
 */

import { Uri, workspace } from 'vscode';
import { IConfigurationService } from '../interfaces/index.js';
import { CompilerInfo, CompilationInfo } from '../types/index.js';

export class ConfigurationService implements IConfigurationService {
	/**
	 * Get configured compilers from workspace settings
	 */
	getCompilers(): CompilerInfo[] {
		const scope = workspace.workspaceFolders?.at(0) ?? null;
		const compilers = workspace.getConfiguration('coglens', scope).get<CompilerInfo[]>('compilers') ?? [];
		
		// Validate all compiler infos
		return compilers.filter(info => {
			if (!this.validateCompilerInfo(info)) {
				console.warn(`Invalid compiler info found in configuration:`, info);
				return false;
			}
			return true;
		});
	}

	/**
	 * Get default compilation info from workspace settings
	 */
	getDefaultCompilationInfo(): CompilationInfo | undefined {
		const scope = workspace.workspaceFolders?.at(0) ?? null;
		const defaultCompileInfo = workspace.getConfiguration('coglens', scope).get<CompilationInfo>('defaultCompileInfo');

		// VS Code returns an empty object if the config value isn't set
		// https://github.com/Microsoft/vscode/issues/35451
		if (defaultCompileInfo !== undefined && Object.keys(defaultCompileInfo).length > 0) {
			if (this.validateCompilationInfo(defaultCompileInfo)) {
				return defaultCompileInfo;
			}
			console.warn('Invalid default compilation info found in configuration:', defaultCompileInfo);
		}

		return undefined;
	}

	/**
	 * Get whether to dim unused source lines for a specific file
	 */
	getDimUnusedSourceLines(uri: Uri): boolean {
		const config = workspace.getConfiguration('', uri);
		return config.get('coglens.dimUnusedSourceLines', true);
	}

	/**
	 * Validate that an object is a valid CompilerInfo
	 */
	validateCompilerInfo(info: unknown): info is CompilerInfo {
		if (typeof info !== 'object' || info === null) {
			return false;
		}

		const obj = info as Record<string, unknown>;

		// Check required fields
		if (typeof obj.name !== 'string' || obj.name.trim() === '') {
			return false;
		}
		if (typeof obj.type !== 'string' || obj.type.trim() === '') {
			return false;
		}
		if (typeof obj.exe !== 'string' || obj.exe.trim() === '') {
			return false;
		}
		if (typeof obj.includeFlag !== 'string') {
			return false;
		}
		if (typeof obj.defineFlag !== 'string') {
			return false;
		}

		// Check optional fields if present
		if (obj.args !== undefined && !Array.isArray(obj.args)) {
			return false;
		}
		if (obj.includePaths !== undefined && !Array.isArray(obj.includePaths)) {
			return false;
		}
		if (obj.defines !== undefined && !Array.isArray(obj.defines)) {
			return false;
		}
		if (obj.envVars !== undefined && typeof obj.envVars !== 'object') {
			return false;
		}

		return true;
	}

	/**
	 * Validate that an object is a valid CompilationInfo
	 */
	validateCompilationInfo(info: unknown): info is CompilationInfo {
		if (typeof info !== 'object' || info === null) {
			return false;
		}

		const obj = info as Record<string, unknown>;

		// Check required fields
		if (typeof obj.compilerName !== 'string') {
			return false;
		}
		if (!Array.isArray(obj.defines)) {
			return false;
		}
		if (!Array.isArray(obj.includes)) {
			return false;
		}
		if (!Array.isArray(obj.args)) {
			return false;
		}

		return true;
	}
}
