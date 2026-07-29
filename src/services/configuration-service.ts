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
import type {
	ArtifactOptions,
	DefaultCompilationSettings,
	ToolchainProfile,
} from '../types/index.js';
import { defaultArtifactOptions } from '../types/index.js';
import * as logger from '../logger.js';
import {
	normalizeToolchainSettings,
	normalizeArtifactOptions,
	normalizeDefaultCompilationSettings,
	toolchainProfileToSettings,
} from './configuration-normalization.js';

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

	getToolchains(scope?: Uri): ToolchainProfile[] {
		const raw = workspace.getConfiguration('coglens', scope).get<unknown>('toolchains', []);
		if (!Array.isArray(raw)) {
			logger.logChannel.error('Ignoring invalid coglens.toolchains: expected an array');
			return [];
		}
		const profiles: ToolchainProfile[] = [];
		raw.forEach((item, index) => {
			const normalized = normalizeToolchainSettings(item);
			if (normalized.ok) {
				profiles.push(normalized.value);
			} else {
				logger.logChannel.error(
					`Ignoring invalid coglens.toolchains[${index}]: ${normalized.errors.join('; ')}`,
				);
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
		if (!normalized.ok) {
			logger.logChannel.error(`Ignoring invalid coglens.defaultCompileInfo: ${normalized.errors.join('; ')}`);
			return undefined;
		}
		return normalized.value;
	}

	getArtifactOptions(scope?: Uri): ArtifactOptions {
		const raw = workspace.getConfiguration('coglens', scope).get<unknown>('filters', {});
		const normalized = normalizeArtifactOptions(raw);
		if (!normalized.ok) {
			logger.logChannel.error(`Ignoring invalid coglens.filters: ${normalized.errors.join('; ')}`);
			return defaultArtifactOptions;
		}
		return normalized.value;
	}

	getDimUnusedSourceLines(uri: Uri): boolean {
		return workspace.getConfiguration('coglens', uri).get('dimUnusedSourceLines', true);
	}

	async updateToolchains(profiles: readonly ToolchainProfile[], folder?: WorkspaceFolder): Promise<void> {
		await workspace.getConfiguration('coglens', folder?.uri).update(
			'toolchains',
			profiles.map(toolchainProfileToSettings),
			ConfigurationTarget.Workspace,
		);
	}

	async updateArtifactOptions(options: ArtifactOptions, folder?: WorkspaceFolder): Promise<void> {
		await workspace.getConfiguration('coglens', folder?.uri).update(
			'filters',
			{ ...options.production, ...options.display },
			folder ? ConfigurationTarget.WorkspaceFolder : ConfigurationTarget.Workspace,
		);
	}

	dispose(): void {
		this.configurationSubscription.dispose();
		this.changeEmitter.dispose();
	}
}
