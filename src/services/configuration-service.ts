import os from 'node:os';
import { ConfigurationTarget, Disposable, Event, EventEmitter, Uri, workspace } from 'vscode';
import type {
	ArtifactOptionId,
	ArtifactOptions,
	ArtifactKind,
	DefaultCompilationSettings,
	ManualCompilationVariantSettings,
	ToolchainProfile,
	ToolchainSettings,
} from '../types/index.js';
import type { ArtifactPreset, ArtifactPresetConfiguration } from '../artifacts/ui/presets.js';
import * as logger from '../logger.js';
import {
	formerOptionIds,
	parseArtifactOptions,
	parseArtifactPresets,
	parseDefaultCompilationSettings,
	parseManualCompilationVariants,
	parseToolchainSettings,
	spelledManualCompilationVariant,
	spelledPresetArguments,
} from './configuration-normalization.js';
import {
	definesArtifactOption,
	definingScope,
	resourceScopes,
	windowScopes,
	withArtifactOption,
	withListEntry,
	withMapEntry,
	withoutListEntry,
	withoutMapEntry,
	type SettingScope,
	type SettingScopes,
} from './settings-scopes.js';
import { portablePath, type PathContext } from './path-variables.js';
import type { ProcessLimits } from '../exec.js';

/** A change to Cogitator Lens settings. */
export interface SettingsChange {
	/** Whether the change affects `coglens.<key>`. */
	affects(key: string): boolean;
}

export class ConfigurationService implements Disposable {
	private readonly changeEmitter = new EventEmitter<SettingsChange>();
	private readonly configurationSubscription: Disposable;
	private pendingWrite: Promise<unknown> = Promise.resolve();

	readonly onDidChange: Event<SettingsChange> = this.changeEmitter.event;

	constructor() {
		this.configurationSubscription = workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration('coglens')) {
				this.changeEmitter.fire({ affects: (key) => event.affectsConfiguration(`coglens.${key}`) });
			}
		});
	}

	getToolchains(scope?: Uri): ToolchainProfile[] {
		const raw = workspace.getConfiguration('coglens', scope).get<unknown>('toolchains', []);
		const entries = Array.isArray(raw) ? raw : [];
		const profiles: ToolchainProfile[] = [];
		entries.forEach((entry, index) => {
			const profile = parseToolchainSettings(entry, this.pathContext(scope));
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
		return parseDefaultCompilationSettings(raw, this.pathContext(scope));
	}

	getManualCompilationVariants(): ManualCompilationVariantSettings[] {
		const raw = workspace.getConfiguration('coglens').get<unknown>('compileVariants', []);
		return parseManualCompilationVariants(raw, this.pathContext());
	}

	/** A workspace variant's working directory, arguments, and environment with their variables, for editing. */
	getSpelledManualCompilationVariant(
		id: string,
	): Pick<ManualCompilationVariantSettings, 'workingDirectory' | 'arguments' | 'environment'> | undefined {
		return spelledManualCompilationVariant(
			workspace.getConfiguration('coglens').get<unknown>('compileVariants', []),
			id,
		);
	}

	getArtifactOptions(kind: ArtifactKind, scope?: Uri): ArtifactOptions {
		const scopes = this.scopes<unknown>('artifactOptions', scope);
		return parseArtifactOptions(
			resourceScopes.map((name) => scopes[name]),
			kind,
		);
	}

	getArtifactPresets(scope?: Uri): readonly ArtifactPreset[] {
		const raw = workspace.getConfiguration('coglens', scope).get<unknown>('artifactPresets', {});
		return parseArtifactPresets(raw, this.pathContext(scope));
	}

	/** A preset's extra arguments with their variables, for editing. */
	getSpelledPresetArguments(id: string, scope?: Uri): string[] | undefined {
		return spelledPresetArguments(
			workspace.getConfiguration('coglens', scope).get<unknown>('artifactPresets', {}),
			id,
		);
	}

	/**
	 * What variables in settings refer to. `${workspaceFolder}` is the folder of the scope, or the
	 * first workspace folder for settings that apply to the whole window.
	 */
	pathContext(scope?: Uri): PathContext {
		const folders = (workspace.workspaceFolders ?? [])
			.filter((folder) => folder.uri.scheme === 'file')
			.map((folder) => ({ name: folder.name, path: folder.uri.fsPath }));
		const scoped = scope ? workspace.getWorkspaceFolder(scope) : undefined;
		return {
			folders,
			defaultFolder: scoped?.uri.scheme === 'file' ? scoped.uri.fsPath : folders[0]?.path,
			userHome: os.homedir(),
			environment: process.env,
		};
	}

	getDimUnusedSourceLines(uri: Uri): boolean {
		return workspace.getConfiguration('coglens', uri).get('dimUnusedSourceLines', true);
	}

	getSynchronizeSourceAndArtifactScrolling(uri: Uri): boolean {
		return workspace.getConfiguration('coglens', uri).get('synchronizeSourceAndArtifactScrolling', true);
	}

	/** The time and output that each compiler or tool run may use. */
	getProcessLimits(): ProcessLimits {
		const configuration = workspace.getConfiguration('coglens');
		const positive = (value: unknown, fallback: number): number =>
			typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
		return {
			timeoutMs: Math.round(positive(configuration.get('processTimeout'), 60) * 1000),
			maxOutputBytes: Math.round(positive(configuration.get('processOutputLimit'), 50) * 1024 * 1024),
		};
	}

	getDetectToolchainsOnPath(): boolean {
		return workspace.getConfiguration('coglens').get('detectToolchainsOnPath', true);
	}

	getCompilationDatabases(scope?: Uri): readonly string[] {
		return workspace.getConfiguration('coglens', scope).get<string[]>('compilationDatabases', []);
	}

	/**
	 * Adds a toolchain, or replaces the one with the same display name. Lists are written whole in
	 * the scope that defines them, because a list in a more specific scope hides the others. An
	 * absolute executable in a workspace folder is written relative to it in workspace settings.
	 */
	async upsertToolchain(entry: ToolchainSettings): Promise<void> {
		await this.updateList('toolchains', (entries, scope) =>
			withListEntry(entries, 'displayName', { ...entry, executable: this.spellPath(entry.executable, scope) }),
		);
	}

	async removeToolchain(displayName: string): Promise<void> {
		await this.updateList('toolchains', (entries) => withoutListEntry(entries, 'displayName', displayName));
	}

	/**
	 * Adds a workspace compilation variant, or replaces the one with the same ID. Its paths are
	 * spelled relative to a workspace folder only in workspace settings.
	 */
	async upsertManualCompilationVariant(entry: ManualCompilationVariantSettings): Promise<void> {
		await this.updateList('compileVariants', (entries, scope) =>
			withListEntry(entries, 'id', {
				...entry,
				source: this.spellPath(entry.source, scope),
				workingDirectory: this.spellPath(entry.workingDirectory, scope),
			}),
		);
	}

	async removeManualCompilationVariant(id: string): Promise<void> {
		await this.updateList('compileVariants', (entries) => withoutListEntry(entries, 'id', id));
	}

	/**
	 * Sets one artifact option in the scope that already sets it, or in user settings. It never
	 * copies the other options, or values from other scopes, into a workspace.
	 */
	async updateArtifactOption(kind: ArtifactKind, id: ArtifactOptionId, value: boolean): Promise<void> {
		await this.serialized(async () => {
			const formerIds = formerOptionIds(kind, id);
			const scopes = this.scopes<unknown>('artifactOptions');
			const scope =
				definingScope(
					scopes,
					(current) => definesArtifactOption(current, kind, [id, ...formerIds]),
					windowScopes,
				) ?? 'user';
			await this.write('artifactOptions', scope, withArtifactOption(scopes[scope], kind, id, value, formerIds));
		});
	}

	/**
	 * Saves a preset, renaming `previousId` when given. An existing preset stays in its scope;
	 * a new one goes to the folder of `resource`, the workspace, or user settings.
	 */
	async upsertArtifactPreset(preset: ArtifactPreset, previousId?: string, resource?: Uri): Promise<void> {
		await this.serialized(async () => {
			const scopes = this.scopes<unknown>('artifactPresets', resource);
			const scope =
				definingScope(scopes, definesKey(previousId ?? preset.id), resourceScopes) ??
				definingScope(scopes, definesKey(preset.id), resourceScopes) ??
				this.newEntryScope(resource);
			const configuration: ArtifactPresetConfiguration = {
				artifactKind: preset.artifactKind,
				extraArguments: [...preset.extraArguments],
				productionOptions: { ...preset.productionOptions },
			};
			await this.write(
				'artifactPresets',
				scope,
				withMapEntry(scopes[scope], preset.id, configuration, previousId),
				resource,
			);
		});
	}

	/** Deletes a preset from every scope that defines it, so a less specific one does not reappear. */
	async removeArtifactPreset(id: string, resource?: Uri): Promise<void> {
		await this.serialized(async () => {
			const scopes = this.scopes<unknown>('artifactPresets', resource);
			for (const scope of resourceScopes) {
				if (scopes[scope] !== undefined && definesKey(id)(scopes[scope])) {
					await this.write('artifactPresets', scope, withoutMapEntry(scopes[scope], id), resource);
				}
			}
		});
	}

	private async updateList(key: string, change: (entries: unknown, scope: SettingScope) => unknown[]): Promise<void> {
		await this.serialized(async () => {
			const scopes = this.scopes<unknown>(key);
			const scope = definingScope(scopes, Array.isArray, windowScopes) ?? this.newEntryScope();
			await this.write(key, scope, change(scopes[scope], scope));
		});
	}

	/**
	 * Runs one change to settings after the ones before it, so each reads what the last wrote
	 * rather than a value that a write still in flight is about to replace.
	 */
	private serialized(change: () => Promise<void>): Promise<void> {
		const result = this.pendingWrite.then(change, change);
		this.pendingWrite = result.catch(() => undefined);
		return result;
	}

	/**
	 * Spells a path inside a workspace folder relative to it in workspace settings, which travel
	 * with the folder. User settings keep it absolute, since they apply to every workspace.
	 */
	private spellPath(value: string, scope: SettingScope): string {
		return scope === 'user' ? value : portablePath(value, this.pathContext());
	}

	private scopes<T>(key: string, resource?: Uri): SettingScopes<T> {
		const inspected = workspace.getConfiguration('coglens', resource).inspect<T>(key);
		return {
			// A folder value only differs from the workspace value in a multi-root workspace.
			workspaceFolder: workspace.workspaceFile ? inspected?.workspaceFolderValue : undefined,
			workspace: inspected?.workspaceValue,
			user: inspected?.globalValue,
		};
	}

	/** Where a new entry goes: the resource's folder in a multi-root workspace, the workspace, or user settings. */
	private newEntryScope(resource?: Uri): SettingScope {
		if (!workspace.workspaceFile && !workspace.workspaceFolders?.length) {
			return 'user';
		}
		return workspace.workspaceFile && resource && workspace.getWorkspaceFolder(resource)
			? 'workspaceFolder'
			: 'workspace';
	}

	private async write(key: string, scope: SettingScope, value: unknown, resource?: Uri): Promise<void> {
		const target =
			scope === 'workspaceFolder'
				? ConfigurationTarget.WorkspaceFolder
				: scope === 'workspace'
					? ConfigurationTarget.Workspace
					: ConfigurationTarget.Global;
		await workspace.getConfiguration('coglens', resource).update(key, value, target);
	}

	dispose(): void {
		this.configurationSubscription.dispose();
		this.changeEmitter.dispose();
	}
}

function definesKey(key: string): (value: unknown) => boolean {
	return (value) => typeof value === 'object' && value !== null && Object.hasOwn(value, key);
}
