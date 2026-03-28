import { Uri, workspace, Disposable } from 'vscode';
import { BuildsystemCompileInfo, BuildsystemMonitor } from './buildsystem-monitor';
import * as cmakeTools from 'vscode-cmake-tools';
import * as logger from '../logger';
import path from 'path';

// Monitors CMake project and outputs a mapping of file URI to compile info
export class CmakeMonitor extends BuildsystemMonitor {
	readonly name = 'CMake';

	private cmakeApi?: cmakeTools.CMakeToolsApi;
	private cmakeProject?: cmakeTools.Project;
	private disposables: Disposable[] = [];

	public async initialize(): Promise<void> {
		try {
			this.cmakeApi = await cmakeTools.getCMakeToolsApi(cmakeTools.Version.latest);
		} catch (error) {
			logger.logAndShowWarning(`Failed to initialize CMake Tools API: ${error}`);
			return;
		}

		if (this.cmakeApi === undefined) {
			logger.logChannel.info('CMake Tools API is not available. CMake integration disabled.');
			return;
		}

		const projectRegistration = this.cmakeApi.onActiveProjectChanged(this.onProjectChange, this);
		this.disposables.push(projectRegistration);

		if (workspace.workspaceFolders !== undefined) {
			await this.onProjectChange(workspace.workspaceFolders[0].uri);
		}
	}

	public async refresh(): Promise<void> {
		await this.onCodeModelChanged();
	}

	public dispose(): void {
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
		super.dispose();
	}

	private async onProjectChange(projectUri?: Uri): Promise<void> {
		if (projectUri === undefined) {
			return;
		}

		try {
			this.cmakeProject = await this.cmakeApi?.getProject(projectUri);
		} catch (error) {
			logger.logAndShowError(`Failed to get CMake project: ${error}`);
			return;
		}

		if (this.cmakeProject !== undefined) {
			await this.onCodeModelChanged();

			const codeModelRegistration = this.cmakeProject.onCodeModelChanged(this.onCodeModelChanged, this);
			this.disposables.push(codeModelRegistration);
		}
	}

	private async onCodeModelChanged(): Promise<void> {
		let activeBuildType: string | undefined;

		try {
			activeBuildType = await this.cmakeProject?.getActiveBuildType();
		} catch (error) {
			logger.logAndShowError(`Failed to get active CMake build type: ${error}`);
			return;
		}

		if (activeBuildType === undefined) {
			logger.logChannel.warn('No active CMake build type found.');
			return;
		}

		const compilationInfo: [Uri, BuildsystemCompileInfo][] = [];

		// Get all projects for the active build type
		const projects = this.cmakeProject?.codeModel?.configurations?.filter(cfg => cfg.name === activeBuildType).flatMap(cfg => cfg.projects) ?? [];

		for (let project of projects) {
			for (let target of project.targets) {
				const sourceDir = target.sourceDirectory ?? project.sourceDirectory;

				for (let fileGroup of target.fileGroups ?? []) {
					if (fileGroup.language === undefined) {
						continue;
					}

					const compiler = this.cmakeProject?.codeModel?.toolchains?.get(fileGroup.language);

					if (compiler === undefined) {
						continue;
					}

					let info: BuildsystemCompileInfo = {
						compilerPath: Uri.file(compiler.path),
						defines: fileGroup.defines ?? [],
						includes: fileGroup.includePath?.map(({ path }, _) => path) ?? [],

					// Split command fragments respecting quoted strings
					args: fileGroup.compileCommandFragments?.flatMap(str => splitCommandFragment(str)) ?? []
					};

					for (let source of fileGroup.sources) {
						const fileUri = Uri.file(path.join(sourceDir, source));
						compilationInfo.push([fileUri, info]);
					}
				}
			}
		}

		if (compilationInfo.length > 0) {
			this.compilationInfoEvent.fire(compilationInfo);
		}
	}
}

/**
 * Split a command fragment string into arguments, respecting double-quoted strings.
 */
function splitCommandFragment(fragment: string): string[] {
	const args: string[] = [];
	let current = '';
	let inQuotes = false;

	for (let i = 0; i < fragment.length; i++) {
		const ch = fragment[i];
		if (ch === '"') {
			inQuotes = !inQuotes;
		} else if (ch === ' ' && !inQuotes) {
			if (current.length > 0) {
				args.push(current);
				current = '';
			}
		} else {
			current += ch;
		}
	}

	if (current.length > 0) {
		args.push(current);
	}

	return args;
}
