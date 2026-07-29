import fs from 'fs';
import path from 'path';
import {
	Disposable,
	RelativePattern,
	Uri,
	WorkspaceFolder,
	workspace,
} from 'vscode';
import { VariantProvider } from './variant-provider.js';
import {
	compilationDatabaseProviderId,
	parseCompilationDatabase,
} from './compilation-database-parser.js';
import type {
	CompilationVariant,
	ToolchainProfile,
	ProviderSnapshot,
} from '../types/index.js';
import * as logger from '../logger.js';

const defaultCompilationDatabases = [
	'compile_commands.json',
	'build/compile_commands.json',
] as const;

interface DatabaseFile {
	readonly folder: WorkspaceFolder;
	readonly filePath: string;
}

export class CompilationDatabaseVariantProvider extends VariantProvider {
	readonly name = 'Compilation Database';
	readonly providerId = compilationDatabaseProviderId;
	private readonly subscriptions: Disposable[] = [];
	private readonly watchers: Disposable[] = [];
	private refreshGeneration = 0;
	private disposed = false;

	async initialize(): Promise<void> {
		this.subscriptions.push(
			workspace.onDidChangeWorkspaceFolders(() => void this.reconfigure()),
			workspace.onDidChangeConfiguration(event => {
				if (event.affectsConfiguration('coglens.compilationDatabases')) {
					void this.reconfigure();
				}
			}),
		);
		await this.reconfigure();
	}

	async refresh(): Promise<void> {
		const generation = ++this.refreshGeneration;
		const databaseFiles = this.getDatabaseFiles();
		const snapshots = await Promise.all(databaseFiles.map(database => this.readDatabase(database)));
		if (this.disposed || generation !== this.refreshGeneration) {
			return;
		}

		const profiles = new Map<string, ToolchainProfile>();
		const variants: CompilationVariant[] = [];
		for (const snapshot of snapshots) {
			snapshot.toolchainProfiles.forEach(profile => profiles.set(profile.id, profile));
			variants.push(...snapshot.variants);
		}
		this.publish({
			provider: this.providerId,
			toolchainProfiles: [...profiles.values()],
			variants,
		});
	}

	override dispose(): void {
		this.disposed = true;
		this.refreshGeneration++;
		this.watchers.splice(0).forEach(watcher => watcher.dispose());
		this.subscriptions.splice(0).forEach(subscription => subscription.dispose());
		super.dispose();
	}

	private async reconfigure(): Promise<void> {
		this.watchers.splice(0).forEach(watcher => watcher.dispose());
		for (const database of this.getDatabaseFiles()) {
			const watcher = workspace.createFileSystemWatcher(new RelativePattern(
				Uri.file(path.dirname(database.filePath)),
				path.basename(database.filePath),
			));
			this.watchers.push(
				watcher,
				watcher.onDidCreate(() => void this.refresh()),
				watcher.onDidChange(() => void this.refresh()),
				watcher.onDidDelete(() => void this.refresh()),
			);
		}
		await this.refresh();
	}

	private getDatabaseFiles(): DatabaseFile[] {
		const files = new Map<string, DatabaseFile>();
		for (const folder of workspace.workspaceFolders ?? []) {
			if (folder.uri.scheme !== 'file') {
				logger.logChannel.warn(
					`Compilation databases are not supported for non-file workspace folder ${folder.uri.toString()}`,
				);
				continue;
			}
			const configured = workspace.getConfiguration('coglens', folder.uri)
				.get<unknown>('compilationDatabases', [...defaultCompilationDatabases]);
			if (!Array.isArray(configured) || configured.some(value => typeof value !== 'string')) {
				logger.logChannel.error(
					`Ignoring invalid coglens.compilationDatabases for ${folder.name}: expected an array of paths`,
				);
				continue;
			}
			for (const configuredPath of configured) {
				if (!configuredPath.trim()) {
					logger.logChannel.warn(
						`Ignoring an empty compilation database path for ${folder.name}`,
					);
					continue;
				}
				const filePath = path.resolve(folder.uri.fsPath, configuredPath);
				const key = process.platform === 'win32' ? filePath.toLowerCase() : filePath;
				files.set(key, { folder, filePath });
			}
		}
		return [...files.values()];
	}

	private async readDatabase(database: DatabaseFile): Promise<ProviderSnapshot> {
		let contents: string;
		try {
			contents = await fs.promises.readFile(database.filePath, 'utf8');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
				logger.logChannel.error(
					`Failed to read compilation database ${database.filePath}: ${String(error)}`,
				);
			}
			return this.emptySnapshot();
		}

		const entries = parseCompilationDatabase(
			contents,
			database.filePath,
			process.platform,
			message => logger.logChannel.warn(
				`Ignoring malformed compilation database ${database.filePath} ${message}`,
			),
		);
		const profiles = new Map<string, ToolchainProfile>();
		const variants: CompilationVariant[] = [];
		const databaseLabel = relativeDatabaseLabel(database);
		const databaseIdentity = normalizeIdentity(database.filePath);

		for (const entry of entries) {
			profiles.set(entry.toolchainProfile.id, entry.toolchainProfile);
			const source = Uri.file(entry.sourceFile);
			const outputLabel = entry.output ? ` · ${path.basename(entry.output)}` : '';
			variants.push({
				id: `${this.providerId}:${databaseIdentity}|${entry.entryIndex}|${source.toString()}`,
				provider: this.providerId,
				project: database.folder.name,
				target: entry.output ? path.basename(entry.output) : undefined,
				configuration: databaseLabel,
				source,
				toolchainProfileId: entry.toolchainProfile.id,
				workingDirectory: entry.workingDirectory,
				arguments: entry.arguments,
				environment: {},
				displayLabel: `${path.basename(entry.toolchainProfile.executable)} · ${databaseLabel}${outputLabel}`,
			});
		}

		return {
			provider: this.providerId,
			toolchainProfiles: [...profiles.values()],
			variants,
		};
	}

	private emptySnapshot(): ProviderSnapshot {
		return { provider: this.providerId, toolchainProfiles: [], variants: [] };
	}
}

function relativeDatabaseLabel(database: DatabaseFile): string {
	const relative = path.relative(database.folder.uri.fsPath, database.filePath);
	return relative && !relative.startsWith('..') && !path.isAbsolute(relative)
		? relative
		: database.filePath;
}

function normalizeIdentity(value: string): string {
	const normalized = path.normalize(value);
	return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
