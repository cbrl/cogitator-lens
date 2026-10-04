import fs from 'fs';
import path from 'path';
import { Disposable, RelativePattern, Uri, WorkspaceFolder, workspace } from 'vscode';
import { emptySnapshot, mergeSnapshots, VariantProvider, type VariantSnapshot } from './variant-provider.js';
import { compilationDatabaseProviderId, parseCompilationDatabase } from './compilation-database-parser.js';
import type { ConfigurationService } from '../services/configuration-service.js';
import type { CompilationVariant, ToolchainProfile } from '../types/index.js';
import * as logger from '../logger.js';
import { canonicalLocalPath, localFileComparisonKey } from '../local-file-identity.js';
import { sourceUriComparisonKey } from '../uri-containers.js';

interface DatabaseFile {
	readonly folder: WorkspaceFolder;
	readonly filePath: string;
}

export class CompilationDatabaseVariantProvider extends VariantProvider {
	private readonly watchers: Disposable[] = [];

	constructor(private readonly configuration: ConfigurationService) {
		super(compilationDatabaseProviderId);
	}

	async initialize(): Promise<void> {
		this.subscriptions.push(
			workspace.onDidChangeWorkspaceFolders(() => void this.reconfigure()),
			workspace.onDidChangeConfiguration((event) => {
				if (event.affectsConfiguration('coglens.compilationDatabases')) {
					void this.reconfigure();
				}
			}),
		);
		await this.reconfigure();
	}

	protected async read(): Promise<VariantSnapshot> {
		return mergeSnapshots(
			await Promise.all(this.getDatabaseFiles().map((database) => this.readDatabase(database))),
		);
	}

	override dispose(): void {
		this.watchers.splice(0).forEach((watcher) => watcher.dispose());
		super.dispose();
	}

	private async reconfigure(): Promise<void> {
		this.watchers.splice(0).forEach((watcher) => watcher.dispose());
		for (const database of this.getDatabaseFiles()) {
			const watcher = workspace.createFileSystemWatcher(
				new RelativePattern(Uri.file(path.dirname(database.filePath)), path.basename(database.filePath)),
			);
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
			for (const configuredPath of this.configuration.getCompilationDatabases(folder.uri)) {
				const filePath = path.resolve(folder.uri.fsPath, configuredPath);
				const key = localFileComparisonKey(filePath);
				files.set(key, { folder, filePath });
			}
		}
		return [...files.values()];
	}

	private async readDatabase(database: DatabaseFile): Promise<VariantSnapshot> {
		let contents: string;
		try {
			contents = await fs.promises.readFile(database.filePath, 'utf8');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
				logger.logChannel.error(`Failed to read compilation database ${database.filePath}: ${String(error)}`);
			}
			return emptySnapshot;
		}

		const entries = parseCompilationDatabase(contents, database.filePath, process.platform, (message) =>
			logger.logChannel.warn(`Ignoring malformed compilation database ${database.filePath} ${message}`),
		);
		const profiles = new Map<string, ToolchainProfile>();
		const variants: CompilationVariant[] = [];
		const databaseLabel = relativeDatabaseLabel(database);
		const databaseIdentity = localFileComparisonKey(database.filePath);

		for (const entry of entries) {
			profiles.set(entry.toolchainProfile.id, entry.toolchainProfile);
			const source = Uri.file(entry.sourceFile);
			const outputLabel = entry.output ? ` · ${path.basename(entry.output)}` : '';
			variants.push({
				id: `${this.providerId}:${databaseIdentity}|${entry.entryIndex}|${sourceUriComparisonKey(source)}`,
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

		return { toolchainProfiles: [...profiles.values()], variants };
	}
}

function relativeDatabaseLabel(database: DatabaseFile): string {
	const relative = path.relative(
		canonicalLocalPath(database.folder.uri.fsPath),
		canonicalLocalPath(database.filePath),
	);
	return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : database.filePath;
}
