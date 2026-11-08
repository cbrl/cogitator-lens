import fs from 'node:fs';
import path from 'node:path';
import { Disposable, RelativePattern, Uri, workspace, type WorkspaceFolder } from 'vscode';
import { mergeSnapshots, VariantProvider, type VariantSnapshot } from './variant-provider.js';
import { readCompilationDatabase } from './compilation-database.js';
import {
	compilerCommand,
	configurationArguments,
	defaultConfiguration,
	orderedConfigurations,
	parseCppToolsProperties,
	type CppToolsConfiguration,
	type CppToolsContext,
	type CppToolsDefaults,
} from './cpptools-configuration.js';
import type { ConfigurationService } from '../services/configuration-service.js';
import type { FolderVariant, ToolchainKind, ToolchainProfile } from '../types/index.js';
import { createToolchainProfile, detectToolchainDefinition } from '../toolchains/toolchain-map.js';
import { findExecutableOnPath, probeCompiler } from '../toolchains/path-detection.js';
import { detectVisualStudioToolchains } from '../toolchains/visual-studio-detection.js';
import { targetFromClangBanner } from '../toolchains/target-architecture.js';
import { localFileComparisonKey } from '../file-identity.js';
import * as logger from '../logger.js';

const propertiesPath = ['.vscode', 'c_cpp_properties.json'] as const;

/** The Visual Studio toolchains, which vswhere finds at most once for each read. */
type VisualStudioToolchains = () => Promise<readonly ToolchainProfile[]>;

/** What one workspace folder gives. */
interface FolderResult {
	readonly snapshot: VariantSnapshot;
	/** The files to watch: the properties file and the compilation databases of its configurations. */
	readonly files: readonly string[];
}

/**
 * Reads the configurations of the C/C++ extension: `.vscode/c_cpp_properties.json` in each
 * workspace folder, and the `C_Cpp.default` settings. A configuration with a compiler gives a
 * folder variant, which each source of the folder without another variant gets. The compilation
 * database of a configuration gives the variants of its sources, unless
 * `coglens.compilationDatabases` reads the same database.
 */
export class CppToolsVariantProvider extends VariantProvider {
	private readonly watchers = new Map<string, Disposable>();

	constructor(private readonly configuration: ConfigurationService) {
		super('cpptools');
	}

	async initialize(): Promise<void> {
		this.subscriptions.push(
			workspace.onDidChangeWorkspaceFolders(() => this.scheduleRefresh()),
			workspace.onDidChangeConfiguration((event) => {
				if (
					event.affectsConfiguration('C_Cpp.default') ||
					event.affectsConfiguration('coglens.cppToolsConfiguration') ||
					event.affectsConfiguration('coglens.compilationDatabases')
				) {
					this.scheduleRefresh();
				}
			}),
		);
		await this.refresh();
	}

	protected async read(): Promise<VariantSnapshot> {
		const folders = (workspace.workspaceFolders ?? []).filter(
			(folder) => folder.uri.scheme === 'file' && this.configuration.getReadCppToolsConfiguration(folder.uri),
		);
		let visualStudio: Promise<readonly ToolchainProfile[]> | undefined;
		const visualStudioToolchains: VisualStudioToolchains = () =>
			(visualStudio ??= detectVisualStudioToolchains(process.env, process.platform));
		const results = await Promise.all(folders.map((folder) => this.readFolder(folder, visualStudioToolchains)));
		if (!this.disposed) {
			this.watch(results.flatMap((result) => result.files));
		}
		return mergeSnapshots(results.map((result) => result.snapshot));
	}

	override dispose(): void {
		this.watchers.forEach((watcher) => watcher.dispose());
		this.watchers.clear();
		super.dispose();
	}

	private async readFolder(folder: WorkspaceFolder, visualStudio: VisualStudioToolchains): Promise<FolderResult> {
		const folderPath = folder.uri.fsPath;
		const context: CppToolsContext = {
			workspaceFolder: folderPath,
			environment: process.env,
			defaults: readDefaults(folder),
		};
		const propertiesFile = path.join(folderPath, ...propertiesPath);
		const text = await readText(propertiesFile);
		const configurations =
			text === undefined
				? [defaultConfiguration(context)].filter((value) => value !== undefined)
				: parseCppToolsProperties(text, context);
		if (text?.trim() && configurations.length === 0) {
			logger.logChannel.warn(`Ignoring ${propertiesFile}: it has no valid configurations.`);
		}
		const coveredDatabases = new Set(
			this.configuration
				.getCompilationDatabases(folder.uri)
				.map((database) => localFileComparisonKey(path.resolve(folderPath, database))),
		);
		const databaseSnapshots: VariantSnapshot[] = [];
		const folderProfiles: ToolchainProfile[] = [];
		const folderVariants: FolderVariant[] = [];
		const databases = new Map<string, string>();
		for (const { key: configurationKey, configuration } of orderedConfigurations(configurations)) {
			for (const database of configuration.compileCommands) {
				const key = localFileComparisonKey(database);
				if (databases.has(key)) {
					continue;
				}
				databases.set(key, database);
				if (!coveredDatabases.has(key)) {
					databaseSnapshots.push(
						await readCompilationDatabase(
							this.providerId,
							{ folder, filePath: database },
							configuration.name,
						),
					);
				}
			}
			const variant = await folderVariant(
				configuration,
				`${localFileComparisonKey(folderPath)}|${configurationKey}`,
				folder,
				visualStudio,
			);
			if (variant) {
				folderProfiles.push(variant.profile);
				folderVariants.push(variant.variant);
			}
		}
		return {
			snapshot: mergeSnapshots([
				...databaseSnapshots,
				{ toolchainProfiles: folderProfiles, variants: [], folderVariants },
			]),
			files: [propertiesFile, ...databases.values()],
		};
	}

	/** Watches each file, so an edit, a new file, or a deleted file refreshes the variants. */
	private watch(files: readonly string[]): void {
		const wanted = new Map(files.map((file) => [localFileComparisonKey(file), file]));
		for (const [key, watcher] of this.watchers) {
			if (!wanted.has(key)) {
				watcher.dispose();
				this.watchers.delete(key);
			}
		}
		for (const [key, file] of wanted) {
			if (this.watchers.has(key)) {
				continue;
			}
			const watcher = workspace.createFileSystemWatcher(
				new RelativePattern(Uri.file(path.dirname(file)), path.basename(file)),
			);
			this.watchers.set(
				key,
				Disposable.from(
					watcher,
					watcher.onDidCreate(() => this.scheduleRefresh()),
					watcher.onDidChange(() => this.scheduleRefresh()),
					watcher.onDidDelete(() => this.scheduleRefresh()),
				),
			);
		}
	}
}

/**
 * The folder variant of a configuration with a C or C++ compiler. The compiler must exist and run,
 * so a configuration for another platform gives no variant. The version banner gives the kind of
 * the compiler, because `/usr/bin/gcc` on macOS is Clang.
 */
async function folderVariant(
	configuration: CppToolsConfiguration,
	id: string,
	folder: WorkspaceFolder,
	visualStudio: VisualStudioToolchains,
): Promise<{ readonly profile: ToolchainProfile; readonly variant: FolderVariant } | undefined> {
	const folderPath = folder.uri.fsPath;
	const command =
		configuration.compilerPath === undefined
			? undefined
			: compilerCommand(configuration.compilerPath, (candidate) => isFile(path.resolve(folderPath, candidate)));
	if (!command) {
		return undefined;
	}
	const executable = await compilerExecutable(command.executable, folderPath, visualStudio);
	if (!executable) {
		logger.logChannel.info(
			`Ignoring the C/C++ configuration "${configuration.name}": this computer has no compiler ${command.executable}.`,
		);
		return undefined;
	}
	const languages = detectToolchainDefinition(executable)?.definition.languageIdentifiers ?? [];
	if (!(languages.includes('c') || languages.includes('cpp'))) {
		logger.logChannel.warn(
			`The C/C++ configuration "${configuration.name}" names ${executable}, which is not a supported C or C++ compiler.`,
		);
		return undefined;
	}
	const probed = await probeCompiler(executable);
	if (!probed) {
		logger.logChannel.warn(
			`Ignoring the C/C++ configuration "${configuration.name}": the compiler ${executable} does not run.`,
		);
		return undefined;
	}
	const dialect = probed.definition.argumentDialect === 'msvc' ? 'msvc' : 'gnu';
	const profile = createToolchainProfile(probed.kind, path.basename(executable), executable, {
		target: targetFromClangBanner(probed.banner),
	});
	return {
		profile,
		variant: {
			id,
			folder: folderPath,
			toolchainProfileId: profile.id,
			workingDirectory: folderPath,
			cArguments: configurationArguments(configuration, dialect, 'c', command.args),
			cppArguments: configurationArguments(configuration, dialect, 'cpp', command.args),
			environment: {},
			displayLabel: `${configuration.name} · ${path.basename(executable)} (C/C++ configuration)`,
			configuration: configuration.name,
		},
	};
}

/** The Visual Studio kinds of the bare compiler names that the C/C++ extension finds without PATH. */
const visualStudioCompilerKinds: Readonly<Record<string, ToolchainKind>> = { cl: 'msvc', 'clang-cl': 'clang-cl' };

/**
 * The file of a compiler. A path is relative to the folder, and on Windows it can leave out `.exe`.
 * A bare name is found on PATH. On Windows, a bare `cl.exe` or `clang-cl.exe` that PATH does not
 * have comes from the first Visual Studio install, as in the C/C++ extension.
 */
async function compilerExecutable(
	command: string,
	folderPath: string,
	visualStudio: VisualStudioToolchains,
): Promise<string | undefined> {
	const windows = process.platform === 'win32';
	if (/[\\/]/.test(command)) {
		const file = path.resolve(folderPath, command);
		return [file, ...(windows && !path.extname(file) ? [`${file}.exe`] : [])].find(isFile);
	}
	const onPath = await findExecutableOnPath(command);
	const kind = visualStudioCompilerKinds[path.win32.parse(command).name.toLowerCase()];
	if (onPath || !windows || !kind) {
		return onPath;
	}
	return (await visualStudio()).find((profile) => profile.kind === kind)?.executable;
}

/** The `C_Cpp.default` settings of a folder. An empty value counts as no value. */
function readDefaults(folder: WorkspaceFolder): CppToolsDefaults {
	const settings = workspace.getConfiguration('C_Cpp.default', folder.uri);
	const text = (key: string): string | undefined => {
		const value = settings.get<unknown>(key);
		return typeof value === 'string' && value.trim() ? value : undefined;
	};
	const list = (key: string): string[] | undefined => {
		const value = settings.get<unknown>(key);
		return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined;
	};
	const compileCommands = settings.get<unknown>('compileCommands');
	return {
		compilerPath: text('compilerPath'),
		compilerArgs: list('compilerArgs'),
		includePath: list('includePath'),
		defines: list('defines'),
		forcedInclude: list('forcedInclude'),
		macFrameworkPath: list('macFrameworkPath'),
		cStandard: text('cStandard'),
		cppStandard: text('cppStandard'),
		compileCommands:
			typeof compileCommands === 'string' && compileCommands.trim()
				? compileCommands
				: Array.isArray(compileCommands)
					? compileCommands.filter((item): item is string => typeof item === 'string')
					: undefined,
	};
}

async function readText(file: string): Promise<string | undefined> {
	try {
		return await fs.promises.readFile(file, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
			logger.logChannel.error(`Failed to read ${file}: ${String(error)}`);
		}
		return undefined;
	}
}

function isFile(candidate: string): boolean {
	try {
		return fs.statSync(candidate).isFile();
	} catch {
		return false;
	}
}
