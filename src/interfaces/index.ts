import type {
	Disposable,
	Event,
	Uri,
	WorkspaceFolder,
} from 'vscode';
import type { ToolchainBackend } from '../toolchains/toolchain-backend.js';
import type {
	CompilationVariant,
	ArtifactOptions,
	ArtifactOptionId,
	RenderedArtifact,
	ArtifactRequest,
	ToolchainProfile,
	DefaultCompilationSettings,
	ProviderSnapshot,
	ReconciliationChange,
} from '../types/index.js';
import type { ConfigurationOrigin } from '../buildsystems/variant-provider.js';

export interface IToolchainRegistry {
	readonly onDidChange: Event<ReconciliationChange<ToolchainProfile>>;
	getProfiles(origin?: ConfigurationOrigin): readonly ToolchainProfile[];
	getToolchainById(id: string): ToolchainBackend | undefined;
	findToolchainByDisplayName(displayName: string): ToolchainBackend | undefined;
	reconcile(
		origin: ConfigurationOrigin,
		profiles: readonly ToolchainProfile[],
	): ReconciliationChange<ToolchainProfile>;
}

export interface IConfigurationService {
	readonly onDidChange: Event<void>;
	getToolchains(scope?: Uri): ToolchainProfile[];
	getDefaultCompilationSettings(scope?: Uri): DefaultCompilationSettings | undefined;
	getArtifactOptions(scope?: Uri): ArtifactOptions;
	getDimUnusedSourceLines(uri: Uri): boolean;
	updateToolchains(profiles: readonly ToolchainProfile[], folder?: WorkspaceFolder): Thenable<void>;
	updateArtifactOptions(options: ArtifactOptions, folder?: WorkspaceFolder): Thenable<void>;
}

export interface ICompilationService extends Disposable {
	readonly toolchainRegistry: IToolchainRegistry;
	readonly onVariantsChanged: Event<readonly Uri[]>;
	readonly onArtifactOptionsChanged: Event<void>;
	readonly artifactOptions: ArtifactOptions;
	setArtifactOption(id: ArtifactOptionId, value: boolean): void;
	getVariants(file: Uri): readonly CompilationVariant[];
	getAllSources(): readonly Uri[];
	getSelectedVariant(file: Uri): CompilationVariant | undefined;
	selectVariant(file: Uri, variantId: string): Promise<boolean>;
	reconcileProviderSnapshot(snapshot: ProviderSnapshot): void;
	compile(request: ArtifactRequest): Promise<RenderedArtifact>;
}

export interface IVariantProvider extends Disposable {
	readonly name: string;
	readonly onSnapshot: Event<ProviderSnapshot>;
	initialize(): Promise<void>;
	refresh(): Promise<void>;
}
