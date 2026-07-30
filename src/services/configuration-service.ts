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
	ToolchainProfile,
	ToolchainSettings,
} from '../types/index.js';
import { artifactDefinitions } from '../artifacts/artifact-definitions.js';
import * as logger from '../logger.js';
import {
	parseArtifactOptions,
	parseDefaultCompilationSettings,
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

	getArtifactOptions(kind: ArtifactKind, scope?: Uri): ArtifactOptions {
		const raw = workspace.getConfiguration('coglens', scope).get<unknown>('artifactOptions', {});
		return parseArtifactOptions(raw, kind);
	}

	getDimUnusedSourceLines(uri: Uri): boolean {
		return workspace.getConfiguration('coglens', uri).get('dimUnusedSourceLines', true);
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
