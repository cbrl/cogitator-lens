import {
	ConfigurationTarget,
	Disposable,
	Event,
	EventEmitter,
	Uri,
	WorkspaceFolder,
	workspace,
} from 'vscode';
import type {
	ArtifactOptions,
	ArtifactKind,
	DefaultCompilationSettings,
	ManualCompilationVariantSettings,
	ToolchainProfile,
	ToolchainSettings,
} from '../types/index.js';
import { artifactDefinitions } from '../artifacts/core/artifact-definitions.js';
import type {
	ArtifactPreset,
	ArtifactPresetConfiguration,
} from '../artifacts/ui/presets.js';
import * as logger from '../logger.js';
import {
	parseArtifactOptions,
	parseArtifactPresets,
	parseDefaultCompilationSettings,
	parseManualCompilationVariants,
	parseToolchainSettings,
} from './configuration-normalization.js';

export class ConfigurationService implements Disposable {
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
		const entries = Array.isArray(raw) ? raw : [];
		const profiles: ToolchainProfile[] = [];
		entries.forEach((entry, index) => {
			const profile = parseToolchainSettings(entry);
			if (profile) {
				profiles.push(profile);
			} else {
				logger.logChannel.error(`Ignoring coglens.toolchains[${index}]: unrecognized toolchain kind`);
			}
		});
		return profiles;
	}

	getDefaultCompilationSettings(scope?: Uri): DefaultCompilationSettings | undefined {
		const raw = workspace.getConfiguration('coglens', scope).get<unknown>('defaultInvocation');
		if (!raw || typeof raw !== 'object' || Object.keys(raw).length === 0) {
			return undefined;
		}
		return parseDefaultCompilationSettings(raw);
	}

	getManualCompilationVariants(): ManualCompilationVariantSettings[] {
		const raw = workspace.getConfiguration('coglens').get<unknown>('compileVariants', []);
		return parseManualCompilationVariants(raw);
	}

	getArtifactOptions(kind: ArtifactKind, scope?: Uri): ArtifactOptions {
		const raw = workspace.getConfiguration('coglens', scope).get<unknown>('artifactOptions', {});
		return parseArtifactOptions(raw, kind);
	}

	getArtifactPresets(scope?: Uri): readonly ArtifactPreset[] {
		const raw = workspace.getConfiguration('coglens', scope).get<unknown>('artifactPresets', {});
		return parseArtifactPresets(raw);
	}

	getDimUnusedSourceLines(uri: Uri): boolean {
		return workspace.getConfiguration('coglens', uri).get('dimUnusedSourceLines', true);
	}

	getSynchronizeSourceAndArtifactScrolling(uri: Uri): boolean {
		return workspace.getConfiguration('coglens', uri)
			.get('synchronizeSourceAndArtifactScrolling', true);
	}

	getCompilationDatabases(scope?: Uri): readonly string[] {
		return workspace.getConfiguration('coglens', scope).get<string[]>('compilationDatabases', []);
	}

	async updateToolchains(profiles: readonly ToolchainProfile[], folder?: WorkspaceFolder): Promise<void> {
		const settings: ToolchainSettings[] = profiles.map(profile => ({
			displayName: profile.displayName,
			kind: profile.kind,
			executable: profile.executable,
			defaultArguments: [...profile.defaultArguments],
			environment: { ...profile.environment },
			tools: { ...profile.tools },
		}));
		await workspace.getConfiguration('coglens', folder?.uri).update(
			'toolchains',
			settings,
			ConfigurationTarget.Workspace,
		);
	}

	async updateManualCompilationVariants(
		variants: readonly ManualCompilationVariantSettings[],
	): Promise<void> {
		await workspace.getConfiguration('coglens').update(
			'compileVariants',
			variants,
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

	async updateArtifactPresets(
		presets: readonly ArtifactPreset[],
		folder?: WorkspaceFolder,
	): Promise<void> {
		const serialized = Object.fromEntries(presets.map(preset => {
			const configuration: ArtifactPresetConfiguration = {
				artifactKind: preset.artifactKind,
				extraArguments: [...preset.extraArguments],
				productionOptions: { ...preset.productionOptions },
			};
			return [preset.id, configuration];
		}));
		await workspace.getConfiguration('coglens', folder?.uri).update(
			'artifactPresets',
			serialized,
			folder ? ConfigurationTarget.WorkspaceFolder : ConfigurationTarget.Workspace,
		);
	}

	dispose(): void {
		this.configurationSubscription.dispose();
		this.changeEmitter.dispose();
	}
}
