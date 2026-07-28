import {
	ConfigurationTarget,
	Disposable,
	Event,
	EventEmitter,
	Uri,
	WorkspaceFolder,
	workspace,
} from 'vscode';
import type { IConfigurationService } from '../interfaces/index.js';
import type { CompilerProfile, DefaultCompilationSettings } from '../types/index.js';
import type { ParseFiltersAndOutputOptions } from '../parsers/filters.interfaces.js';
import * as logger from '../logger.js';
import {
	normalizeCompilerSettings,
	normalizeDefaultCompilationSettings,
	profileToSettings,
} from './configuration-normalization.js';

const defaultFilters: ParseFiltersAndOutputOptions = {
	labels: true,
	directives: true,
	commentOnly: true,
	libraryCode: false,
	dontMaskFilenames: true,
};

export class ConfigurationService implements IConfigurationService, Disposable {
	private readonly changeEmitter = new EventEmitter<void>();
	private readonly configurationSubscription: Disposable;

	readonly onDidChange: Event<void> = this.changeEmitter.event;

	constructor() {
		this.configurationSubscription = workspace.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('coglens')) {
				this.changeEmitter.fire();
			}
		});
	}

	getCompilers(scope?: Uri): CompilerProfile[] {
		const raw = workspace.getConfiguration('coglens', scope).get<unknown[]>('compilers', []);
		const profiles: CompilerProfile[] = [];
		raw.forEach((item, index) => {
			const normalized = normalizeCompilerSettings(item, 'user');
			if (normalized.value) {
				profiles.push(normalized.value);
			} else {
				logger.logChannel.error(`Ignoring invalid coglens.compilers[${index}]: ${normalized.errors.join('; ')}`);
			}
		});
		return profiles;
	}

	getDefaultCompilationSettings(scope?: Uri): DefaultCompilationSettings | undefined {
		const raw = workspace.getConfiguration('coglens', scope).get<unknown>('defaultCompileInfo');
		if (!raw || typeof raw !== 'object' || Object.keys(raw).length === 0) {
			return undefined;
		}
		const normalized = normalizeDefaultCompilationSettings(raw);
		if (!normalized.value) {
			logger.logChannel.error(`Ignoring invalid coglens.defaultCompileInfo: ${normalized.errors.join('; ')}`);
		}
		return normalized.value;
	}

	getFilters(scope?: Uri): ParseFiltersAndOutputOptions {
		return {
			...defaultFilters,
			...workspace.getConfiguration('coglens', scope).get<ParseFiltersAndOutputOptions>('filters', {}),
		};
	}

	getDimUnusedSourceLines(uri: Uri): boolean {
		return workspace.getConfiguration('coglens', uri).get('dimUnusedSourceLines', true);
	}

	async updateCompilers(profiles: readonly CompilerProfile[], folder?: WorkspaceFolder): Promise<void> {
		await workspace.getConfiguration('coglens', folder?.uri).update(
			'compilers',
			profiles.map(profileToSettings),
			ConfigurationTarget.Workspace,
		);
	}

	async updateFilters(filters: ParseFiltersAndOutputOptions, folder?: WorkspaceFolder): Promise<void> {
		await workspace.getConfiguration('coglens', folder?.uri).update(
			'filters',
			filters,
			folder ? ConfigurationTarget.WorkspaceFolder : ConfigurationTarget.Workspace,
		);
	}

	dispose(): void {
		this.configurationSubscription.dispose();
		this.changeEmitter.dispose();
	}
}
