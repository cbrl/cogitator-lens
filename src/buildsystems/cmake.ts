import path from 'path';
import { Disposable, Uri, workspace } from 'vscode';
import * as cmakeTools from 'vscode-cmake-tools';
import { BuildsystemMonitor } from './buildsystem-monitor.js';
import type { CompilationVariant, CompilerProfile, ProviderSnapshot } from '../types/index.js';
import { getCompilerByExe, normalizedExecutableId } from '../compilers/compiler-map.js';
import { tokenizeCommandLine } from '../tokenize.js';
import * as logger from '../logger.js';

interface ProjectState {
	uri: Uri;
	project: cmakeTools.Project;
	codeModelSubscription: Disposable;
}

export class CmakeMonitor extends BuildsystemMonitor {
	readonly name = 'CMake';
	private readonly providerId = 'cmake';
	private api?: cmakeTools.CMakeToolsApi;
	private readonly projects = new Map<string, ProjectState>();
	private readonly subscriptions: Disposable[] = [];
	private refreshGeneration = 0;
	private readonly projectGenerations = new Map<string, number>();
	private disposed = false;

	async initialize(): Promise<void> {
		try {
			this.api = await cmakeTools.getCMakeToolsApi(cmakeTools.Version.latest);
		} catch (error) {
			logger.logChannel.warn(`CMake Tools API could not be initialized: ${String(error)}`);
			return;
		}
		if (!this.api) {
			logger.logChannel.info('CMake Tools is not installed. CMake discovery is disabled.');
			this.publish(this.emptySnapshot());
			return;
		}

		this.subscriptions.push(
			this.api.onActiveProjectChanged(uri => {
				if (uri) {
					void this.attachProject(uri);
				}
			}),
			workspace.onDidChangeWorkspaceFolders(event => {
				for (const removed of event.removed) {
					this.detachProject(removed.uri);
				}
				for (const added of event.added) {
					void this.attachProject(added.uri);
				}
				void this.refresh();
			}),
		);

		await Promise.all((workspace.workspaceFolders ?? []).map(folder => this.attachProject(folder.uri)));
		await this.refresh();
	}

	async refresh(): Promise<void> {
		const generation = ++this.refreshGeneration;
		const snapshots = await Promise.all([...this.projects.values()].map(state => this.readProject(state)));
		if (this.disposed || generation !== this.refreshGeneration) {
			return;
		}

		const profiles = new Map<string, CompilerProfile>();
		const variants: CompilationVariant[] = [];
		for (const snapshot of snapshots) {
			snapshot.compilerProfiles.forEach(profile => profiles.set(profile.id, profile));
			variants.push(...snapshot.variants);
		}

		this.publish({ provider: this.providerId, compilerProfiles: [...profiles.values()], variants });
	}

	override dispose(): void {
		this.disposed = true;
		this.subscriptions.forEach(subscription => subscription.dispose());
		this.projects.forEach(state => state.codeModelSubscription.dispose());
		this.projects.clear();
		this.projectGenerations.clear();
		super.dispose();
	}

	private async attachProject(uri: Uri): Promise<void> {
		const key = this.projectKey(uri);
		const generation = (this.projectGenerations.get(key) ?? 0) + 1;

		this.projectGenerations.set(key, generation);

		let project: cmakeTools.Project | undefined;
		try {
			project = await this.api?.getProject(uri);
		} catch (error) {
			logger.logChannel.error(`Failed to inspect CMake project ${uri.fsPath}: ${String(error)}`);
			return;
		}

		if (this.disposed || this.projectGenerations.get(key) !== generation) {
			return;
		}

		if (!project) {
			this.projects.get(key)?.codeModelSubscription.dispose();
			this.projects.delete(key);
			await this.refresh();
			return;
		}

		this.projects.get(key)?.codeModelSubscription.dispose();
		const codeModelSubscription = project.onCodeModelChanged(() => void this.refresh());
		this.projects.set(key, { uri, project, codeModelSubscription });

		await this.refresh();
	}

	private detachProject(uri: Uri): void {
		const key = this.projectKey(uri);
		this.projectGenerations.set(key, (this.projectGenerations.get(key) ?? 0) + 1);
		this.projects.get(key)?.codeModelSubscription.dispose();
		this.projects.delete(key);
	}

	private async readProject(state: ProjectState): Promise<ProviderSnapshot> {
		const compilerProfiles = new Map<string, CompilerProfile>();
		const variants: CompilationVariant[] = [];
		const codeModel = state.project.codeModel;
		if (!codeModel) {
			return this.emptySnapshot();
		}

		let activeBuildType: string | undefined;
		let buildDirectory: string | undefined;
		try {
			[activeBuildType, buildDirectory] = await Promise.all([
				state.project.getActiveBuildType(),
				state.project.getBuildDirectory(),
			]);
		} catch (error) {
			logger.logChannel.error(`Failed to read CMake state for ${state.uri.fsPath}: ${String(error)}`);
			return this.emptySnapshot();
		}

		const configurations = activeBuildType
			? codeModel.configurations.filter(configuration => configuration.name === activeBuildType)
			: codeModel.configurations;

		for (const configuration of configurations) {
			for (const project of configuration.projects) {
				for (const target of project.targets) {
					const sourceDirectory = target.sourceDirectory ?? project.sourceDirectory;
					for (const [groupIndex, fileGroup] of (target.fileGroups ?? []).entries()) {
						if (!fileGroup.language) {
							continue;
						}

						const toolchain = codeModel.toolchains?.get(fileGroup.language);
						if (!toolchain) {
							continue;
						}

						const Adapter = getCompilerByExe(
							toolchain.path,
							process.platform === 'darwin' ? 'Apple clang' : undefined,
						);
						if (!Adapter) {
							logger.logChannel.warn(`Unsupported CMake compiler: ${toolchain.path}`);
							continue;
						}

						const executableId = normalizedExecutableId(toolchain.path);
						const profileId = `${this.providerId}:${executableId}`;
						const profile = {
							...Adapter.baseCompilerProfile(path.basename(toolchain.path), toolchain.path),
							id: profileId,
							displayName: `${path.basename(toolchain.path)} — ${toolchain.path}`,
						};
						compilerProfiles.set(profileId, profile);

						const argumentsList = this.tokenizeFragments(fileGroup.compileCommandFragments ?? [], target.name);
						for (const source of fileGroup.sources) {
							const sourcePath = path.isAbsolute(source) ? source : path.join(sourceDirectory, source);
							const sourceUri = Uri.file(path.normalize(sourcePath));
							const identity = [
								this.projectKey(state.uri),
								configuration.name,
								project.name,
								target.name,
								String(groupIndex),
								sourceUri.toString(),
							].join('|');

							variants.push({
								id: `${this.providerId}:${identity}`,
								provider: this.providerId,
								project: project.name,
								target: target.name,
								configuration: configuration.name,
								source: sourceUri,
								compilerProfileId: profileId,
								workingDirectory: buildDirectory ?? sourceDirectory,
								arguments: argumentsList,
								includes: fileGroup.includePath?.map(item => item.path) ?? [],
								defines: fileGroup.defines ?? [],
								environment: {},
								displayLabel: `${target.name} · ${configuration.name}`,
							});
						}
					}
				}
			}
		}

		return {
			provider: this.providerId,
			compilerProfiles: [...compilerProfiles.values()],
			variants
		};
	}

	private emptySnapshot(): ProviderSnapshot {
		return { provider: this.providerId, compilerProfiles: [], variants: [] };
	}

	private projectKey(uri: Uri): string {
		const value = (workspace.getWorkspaceFolder(uri)?.uri ?? uri).toString();
		return process.platform === 'win32' ? value.toLowerCase() : value;
	}

	private tokenizeFragments(fragments: readonly string[], targetName: string): string[] {
		try {
			return fragments.flatMap(fragment =>
				tokenizeCommandLine(fragment, process.platform === 'win32' ? 'windows' : 'posix')
			);
		} catch (error) {
			logger.logChannel.error(`Ignoring malformed CMake arguments for target ${targetName}: ${String(error)}`);
			return [];
		}
	}
}
