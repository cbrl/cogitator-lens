import path from 'path';
import { Disposable, Uri, workspace } from 'vscode';
import * as cmakeTools from 'vscode-cmake-tools';
import { emptySnapshot, mergeSnapshots, VariantProvider, type VariantSnapshot } from './variant-provider.js';
import type { CompilationVariant, ToolchainProfile } from '../types/index.js';
import { createToolchainProfile, detectToolchainDefinition } from '../toolchains/toolchain-map.js';
import { flattenCmakeArguments } from './cmake-arguments.js';
import { tokenizeCommandLine } from '../tokenize.js';
import * as logger from '../logger.js';
import { sourceUriComparisonKey } from '../file-identity.js';
import { localFileComparisonKey } from '../file-identity.js';

interface ProjectState {
	uri: Uri;
	project: cmakeTools.Project;
	codeModelSubscription: Disposable;
}

export class CmakeVariantProvider extends VariantProvider {
	private api?: cmakeTools.CMakeToolsApi;
	private readonly projects = new Map<string, ProjectState>();
	private readonly projectGenerations = new Map<string, number>();

	constructor() {
		super('cmake');
	}

	async initialize(): Promise<void> {
		try {
			this.api = await cmakeTools.getCMakeToolsApi(cmakeTools.Version.latest);
		} catch (error) {
			logger.logChannel.warn(`CMake Tools API could not be initialized: ${String(error)}`);
			return;
		}
		if (!this.api) {
			logger.logChannel.info('CMake Tools is not installed. CMake discovery is disabled.');
			this.publish(emptySnapshot);
			return;
		}

		this.subscriptions.push(
			this.api.onActiveProjectChanged((uri) => {
				if (uri) {
					void this.attachProject(uri);
				}
			}),
			workspace.onDidChangeWorkspaceFolders((event) => {
				for (const removed of event.removed) {
					this.detachProject(removed.uri);
				}
				for (const added of event.added) {
					void this.attachProject(added.uri);
				}
				void this.refresh();
			}),
		);

		await Promise.all((workspace.workspaceFolders ?? []).map((folder) => this.attachProject(folder.uri)));
		await this.refresh();
	}

	protected async read(): Promise<VariantSnapshot> {
		return mergeSnapshots(await Promise.all([...this.projects.values()].map((state) => this.readProject(state))));
	}

	override dispose(): void {
		this.projects.forEach((state) => state.codeModelSubscription.dispose());
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

	private async readProject(state: ProjectState): Promise<VariantSnapshot> {
		const toolchainProfiles = new Map<string, ToolchainProfile>();
		const variants: CompilationVariant[] = [];
		const codeModel = state.project.codeModel;
		if (!codeModel) {
			return emptySnapshot;
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
			return emptySnapshot;
		}

		const configurations = activeBuildType
			? codeModel.configurations.filter((configuration) => configuration.name === activeBuildType)
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

						const detected = detectToolchainDefinition(
							toolchain.path,
							process.platform === 'darwin' ? 'Apple clang' : undefined,
						);
						if (!detected) {
							logger.logChannel.warn(`Unsupported CMake compiler: ${toolchain.path}`);
							continue;
						}

						const executableId = localFileComparisonKey(toolchain.path);
						const profileId = executableId;
						const profile = createToolchainProfile(
							detected.kind,
							`${path.basename(toolchain.path)} — ${toolchain.path}`,
							toolchain.path,
							{ id: profileId },
						);
						toolchainProfiles.set(profileId, profile);

						const argumentsList = flattenCmakeArguments(
							this.tokenizeFragments(fileGroup.compileCommandFragments ?? [], target.name),
							fileGroup.includePath?.map((item) => item.path) ?? [],
							fileGroup.defines ?? [],
							detected.kind,
						);
						for (const source of fileGroup.sources) {
							const sourcePath = path.isAbsolute(source) ? source : path.join(sourceDirectory, source);
							const sourceUri = Uri.file(path.normalize(sourcePath));
							const identity = [
								this.projectKey(state.uri),
								configuration.name,
								project.name,
								target.name,
								String(groupIndex),
								sourceUriComparisonKey(sourceUri),
							].join('|');

							variants.push({
								id: `${this.providerId}:${identity}`,
								provider: this.providerId,
								project: project.name,
								target: target.name,
								configuration: configuration.name,
								source: sourceUri,
								toolchainProfileId: profileId,
								workingDirectory: buildDirectory ?? sourceDirectory,
								arguments: argumentsList,
								environment: {},
								displayLabel: `${target.name} · ${configuration.name}`,
							});
						}
					}
				}
			}
		}

		return { toolchainProfiles: [...toolchainProfiles.values()], variants };
	}

	private projectKey(uri: Uri): string {
		const value = (workspace.getWorkspaceFolder(uri)?.uri ?? uri).toString();
		return process.platform === 'win32' ? value.toLowerCase() : value;
	}

	private tokenizeFragments(fragments: readonly string[], targetName: string): string[] {
		try {
			return fragments.flatMap((fragment) =>
				tokenizeCommandLine(fragment, process.platform === 'win32' ? 'windows' : 'posix'),
			);
		} catch (error) {
			logger.logChannel.error(`Ignoring malformed CMake arguments for target ${targetName}: ${String(error)}`);
			return [];
		}
	}
}
