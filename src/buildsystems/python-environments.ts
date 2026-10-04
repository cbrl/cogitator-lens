import path from 'path';
import {
	PythonExtension,
	type Environment,
	type EnvironmentPath,
	type PythonExtension as PythonExtensionApi,
	type ResolvedEnvironment,
} from '@vscode/python-extension';
import { Uri, workspace } from 'vscode';
import type { CompilationVariant } from '../types/index.js';
import * as logger from '../logger.js';
import { emptySnapshot, VariantProvider, type VariantSnapshot } from './variant-provider.js';
import { sourceUriComparisonKey } from '../file-identity.js';
import {
	createPythonEnvironmentProfiles,
	matchesPythonEnvironment,
	pythonEnvironmentVersion,
	type PythonEnvironmentProfile,
} from './python-environment-model.js';

const providerId = 'python-environments';
const pythonSourcePattern = '**/*.py';
const pythonSourceExclusions = '**/{.git,.hg,.svn,.nox,.tox,.venv,__pycache__,env,node_modules,site-packages,venv}/**';

type PythonApiFactory = () => Promise<PythonExtensionApi>;

export class PythonEnvironmentVariantProvider extends VariantProvider {
	private api?: PythonExtensionApi;

	constructor(private readonly apiFactory: PythonApiFactory = () => PythonExtension.api()) {
		super(providerId);
	}

	async initialize(): Promise<void> {
		try {
			this.api = await this.apiFactory();
			await this.api.ready;
		} catch (error) {
			logger.logChannel.info(`Microsoft Python environment discovery is unavailable: ${String(error)}`);
			this.publish(emptySnapshot);
			return;
		}

		this.subscriptions.push(
			this.api.environments.onDidChangeEnvironments(() => void this.refresh()),
			this.api.environments.onDidChangeActiveEnvironmentPath(() => void this.refresh()),
			this.api.environments.onDidEnvironmentVariablesChange(() => void this.refresh()),
			workspace.onDidChangeWorkspaceFolders(() => void this.refresh()),
		);
		const sourceWatcher = workspace.createFileSystemWatcher(pythonSourcePattern);
		this.subscriptions.push(
			sourceWatcher,
			sourceWatcher.onDidCreate(() => void this.refresh()),
			sourceWatcher.onDidDelete(() => void this.refresh()),
		);

		try {
			await this.api.environments.refreshEnvironments();
		} catch (error) {
			logger.logChannel.warn(`Python environment refresh failed: ${String(error)}`);
		}
		await this.refresh();
	}

	protected async read(): Promise<VariantSnapshot> {
		const api = this.api;
		if (!api) {
			return emptySnapshot;
		}
		const [sources, environments] = await Promise.all([
			workspace.findFiles(pythonSourcePattern, pythonSourceExclusions),
			this.resolveEnvironments(api),
		]);
		const profiles = createPythonEnvironmentProfiles(environments);
		return {
			toolchainProfiles: profiles.map((item) => item.profile),
			variants: sources.flatMap((source) => this.createVariants(api, source, profiles)),
		};
	}

	private async resolveEnvironments(api: PythonExtensionApi): Promise<ResolvedEnvironment[]> {
		const active = [
			api.environments.getActiveEnvironmentPath(),
			...(workspace.workspaceFolders ?? []).map((folder) => api.environments.getActiveEnvironmentPath(folder)),
		];
		const candidates: Array<Environment | EnvironmentPath> = [...active, ...api.environments.known];
		const unique = new Map<string, Environment | EnvironmentPath>();
		for (const candidate of candidates) {
			unique.set(`${candidate.id}\0${candidate.path}`, candidate);
		}

		const resolved = await Promise.all(
			[...unique.values()].map(async (candidate) => {
				try {
					return await api.environments.resolveEnvironment(candidate);
				} catch (error) {
					logger.logChannel.warn(`Failed to resolve Python environment ${candidate.path}: ${String(error)}`);
					return undefined;
				}
			}),
		);
		return resolved.filter((environment): environment is ResolvedEnvironment => Boolean(environment));
	}

	private createVariants(
		api: PythonExtensionApi,
		source: Uri,
		profiles: readonly PythonEnvironmentProfile[],
	): CompilationVariant[] {
		const active = api.environments.getActiveEnvironmentPath(source);
		const orderedProfiles = [...profiles].sort((left, right) => {
			const activeOrder =
				Number(matchesPythonEnvironment(active, right)) - Number(matchesPythonEnvironment(active, left));

			return (
				activeOrder ||
				left.profile.displayName.localeCompare(right.profile.displayName, undefined, { sensitivity: 'base' })
			);
		});
		const folder = workspace.getWorkspaceFolder(source);
		const environment = definedEnvironmentVariables(api.environments.getEnvironmentVariables(source));

		return orderedProfiles.map((item) => ({
			id: `${providerId}:${item.profile.id}|${sourceUriComparisonKey(source)}`,
			provider: providerId,
			project: folder?.name,
			target: 'Bytecode',
			configuration: pythonEnvironmentVersion(item.environment),
			source,
			toolchainProfileId: item.profile.id,
			workingDirectory: folder?.uri.fsPath ?? path.dirname(source.fsPath),
			arguments: [],
			environment,
			displayLabel: item.profile.displayName,
		}));
	}
}

function definedEnvironmentVariables(
	environment: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
	return Object.fromEntries(
		Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined),
	);
}
