import type {
	CancellationToken,
	Disposable,
	Event,
	Uri,
	WorkspaceFolder,
} from 'vscode';
import type { CompilerBase } from '../compiler.js';
import type {
	CompilationVariant,
	CompileArtifact,
	CompilerProfile,
	DefaultCompilationSettings,
	ProviderSnapshot,
	ReconciliationChange,
} from '../types/index.js';
import type { ParseFiltersAndOutputOptions } from '../parsers/filters.interfaces.js';

export interface ICompilerRegistry {
	readonly onDidChange: Event<ReconciliationChange<CompilerProfile>>;
	getProfiles(origin?: string): readonly CompilerProfile[];
	getCompilerById(id: string): CompilerBase | undefined;
	findCompilerByDisplayName(displayName: string): CompilerBase | undefined;
	reconcile(origin: string, profiles: readonly CompilerProfile[]): ReconciliationChange<CompilerProfile>;
}

export interface IConfigurationService {
	readonly onDidChange: Event<void>;
	getCompilers(scope?: Uri): CompilerProfile[];
	getDefaultCompilationSettings(scope?: Uri): DefaultCompilationSettings | undefined;
	getFilters(scope?: Uri): ParseFiltersAndOutputOptions;
	getDimUnusedSourceLines(uri: Uri): boolean;
	updateCompilers(profiles: readonly CompilerProfile[], folder?: WorkspaceFolder): Thenable<void>;
	updateFilters(filters: ParseFiltersAndOutputOptions, folder?: WorkspaceFolder): Thenable<void>;
}

export interface ICompilationService extends Disposable {
	readonly compilerRegistry: ICompilerRegistry;
	readonly onVariantsChanged: Event<readonly Uri[]>;
	readonly onFiltersChanged: Event<void>;
	globalFilterOptions: ParseFiltersAndOutputOptions;
	getVariants(file: Uri): readonly CompilationVariant[];
	getSelectedVariant(file: Uri): CompilationVariant | undefined;
	selectVariant(file: Uri, variantId: string): Promise<boolean>;
	reconcileProviderSnapshot(snapshot: ProviderSnapshot): void;
	compile(file: Uri, cancellationToken: CancellationToken): Promise<CompileArtifact>;
}

export interface IBuildSystemMonitor extends Disposable {
	readonly name: string;
	readonly onSnapshot: Event<ProviderSnapshot>;
	initialize(): Promise<void>;
	refresh(): Promise<void>;
}
