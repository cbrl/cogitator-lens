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
	ArtifactKind,
	DefaultCompilationSettings,
	ToolchainProfile,
} from '../types/index.js';
import { defaultArtifactOptions } from '../types/index.js';
import { artifactDefinitions } from '../artifacts/artifact-definitions.js';
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
		const raw = workspace.getConfiguration('coglens', scope).get<unknown>('defaultInvocation');
		if (!raw || typeof raw !== 'object' || Object.keys(raw).length === 0) {
			return undefined;
		}
		const normalized = normalizeDefaultCompilationSettings(raw);
		if (!normalized.ok) {
			logger.logChannel.error(`Ignoring invalid coglens.defaultInvocation: ${normalized.errors.join('; ')}`);
			return undefined;
		}
		return normalized.value;
	}

	getArtifactOptions(kind: ArtifactKind, scope?: Uri): ArtifactOptions {
		const raw = workspace.getConfiguration('coglens', scope).get<unknown>('artifactOptions', {});
		const normalized = normalizeArtifactOptions(raw, kind);
		if (!normalized.ok) {
			logger.logChannel.error(`Ignoring invalid coglens.artifactOptions: ${normalized.errors.join('; ')}`);
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

	async updateArtifactOptions(
		kind: ArtifactKind,
		options: ArtifactOptions,
		folder?: WorkspaceFolder,
	): Promise<void> {
		const configuration = workspace.getConfiguration('coglens', folder?.uri);
		const current = configuration.get<Record<string, unknown>>('artifactOptions', {});
		const flat = { ...options.production, ...options.display };
		const serialized = Object.fromEntries(
			artifactDefinitions[kind].options.map(descriptor => [
				descriptor.id,
				flat[descriptor.id],
			]),
		);
		await configuration.update(
			'artifactOptions',
			{
				...current,
				[kind]: serialized,
			},
			folder ? ConfigurationTarget.WorkspaceFolder : ConfigurationTarget.Workspace,
		);
	}

	dispose(): void {
		this.configurationSubscription.dispose();
		this.changeEmitter.dispose();
	}
}
