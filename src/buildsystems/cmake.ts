import { Uri, workspace, Disposable } from 'vscode';
import { BuildsystemCompileInfo, BuildsystemMonitor } from './buildsystem-monitor';
import { CompilationInfo } from '../compile-database';
import * as cmakeTools from 'vscode-cmake-tools';
import path from 'path';

// Monitors CMake project and outputs a mapping of file URI to compile info
export class CmakeMonitor extends BuildsystemMonitor {
	private cmakeApi?: cmakeTools.CMakeToolsApi;
	private cmakeProject?: cmakeTools.Project;
	private disposables: Disposable[] = [];

	public async initCmakeApi(): Promise<void> {
		this.cmakeApi = await cmakeTools.getCMakeToolsApi(cmakeTools.Version.latest);

		if (this.cmakeApi === undefined) {
			return;
		}

		const projectRegistration = this.cmakeApi.onActiveProjectChanged(this.onProjectChange, this);
		this.disposables.push(projectRegistration);

		if (workspace.workspaceFolders !== undefined) {
			await this.onProjectChange(workspace.workspaceFolders[0].uri);
		}
	}

	public dispose(): void {
		for (let disposable of this.disposables) {
			disposable.dispose();
		}
	}

	private async onProjectChange(projectUri?: Uri): Promise<void> {
		if (projectUri === undefined) {
			return;
		}

		this.cmakeProject = await this.cmakeApi?.getProject(projectUri);

		if (this.cmakeProject !== undefined) {
			await this.onCodeModelChanged();

			const codeModelRegistration = this.cmakeProject.onCodeModelChanged(this.onCodeModelChanged, this);
			this.disposables.push(codeModelRegistration);
		}
	}

	private async onCodeModelChanged(): Promise<void> {
		const activeBuildType = await this.cmakeProject?.getActiveBuildType();

		if (activeBuildType === undefined) {
			// TODO: notify user?
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

						// Each command fragment can be a string with multiple args. It needs to be split in this case.
						args: fileGroup.compileCommandFragments?.flatMap(str => str.split(/\s+/)) ?? []
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
