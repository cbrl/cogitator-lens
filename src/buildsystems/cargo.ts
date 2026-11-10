import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Uri, workspace } from 'vscode';
import { execute } from '../exec.js';
import * as logger from '../logger.js';
import type { ConfigurationService } from '../services/configuration-service.js';
import { findExecutableOnPath } from '../toolchains/path-detection.js';
import { createToolchainProfile } from '../toolchains/toolchain-map.js';
import {
	cargoProviderId,
	cargoVariant,
	parseCargoMetadata,
	readCargoWorkspaces,
	type CargoPackage,
	type CargoWorkspace,
} from './cargo-metadata.js';
import { emptySnapshot, VariantProvider, type VariantSnapshot } from './variant-provider.js';

const manifestPattern = '**/Cargo.toml';
const rustSourcePattern = '**/*.rs';
const excludedFolders = '**/{target,node_modules,.git}/**';
/** A checkout changes many files, so a burst of events reads the workspaces once. */
const cargoRefreshDelayMs = 500;
/** `cargo metadata --no-deps` reads the manifests only, so it does not wait for the network. */
const metadataTimeoutMs = 60_000;

/**
 * Gives each Rust source of a Cargo package a variant with the configured profile. The variant runs
 * `cargo rustc` for the target that compiles the source.
 */
export class CargoVariantProvider extends VariantProvider {
	private reportedMissingCargo = false;

	constructor(private readonly configuration: ConfigurationService) {
		super(cargoProviderId);
	}

	async initialize(): Promise<void> {
		const refreshSoon = (): void => this.scheduleRefresh(cargoRefreshDelayMs);
		const manifests = workspace.createFileSystemWatcher(manifestPattern);
		// A changed source keeps its target. Only a new or a removed source changes the variants.
		const sources = workspace.createFileSystemWatcher(rustSourcePattern, false, true, false);
		this.subscriptions.push(
			manifests,
			manifests.onDidCreate(refreshSoon),
			manifests.onDidChange(refreshSoon),
			manifests.onDidDelete(refreshSoon),
			sources,
			sources.onDidCreate(refreshSoon),
			sources.onDidDelete(refreshSoon),
			workspace.onDidChangeWorkspaceFolders(refreshSoon),
			workspace.onDidChangeConfiguration((event) => {
				if (
					event.affectsConfiguration('coglens.cargoWorkspaces') ||
					event.affectsConfiguration('coglens.cargoProfile')
				) {
					refreshSoon();
				}
			}),
		);
		await this.refresh();
	}

	protected async read(): Promise<VariantSnapshot> {
		const manifests = (await workspace.findFiles(manifestPattern, excludedFolders)).filter(
			(uri) => uri.scheme === 'file' && this.configuration.getReadCargoWorkspaces(uri),
		);
		if (manifests.length === 0) {
			return emptySnapshot;
		}
		const executable = await findCargo();
		if (!executable) {
			if (!this.reportedMissingCargo) {
				this.reportedMissingCargo = true;
				logger.logChannel.info('The workspace has Cargo manifests, but Cargo is not on PATH or in CARGO_HOME.');
			}
			return emptySnapshot;
		}
		const workspaces = await readCargoWorkspaces(
			manifests.map((uri) => uri.fsPath),
			(manifest) => readCargoMetadata(executable, manifest),
		);
		if (workspaces.length === 0) {
			return emptySnapshot;
		}
		const profile = createToolchainProfile('cargo', 'Cargo', executable);
		const sources = await workspace.findFiles(rustSourcePattern, excludedFolders);
		const profileOf = (cargoPackage: CargoPackage): string =>
			this.configuration.getCargoProfile(Uri.file(cargoPackage.manifestPath));
		return {
			toolchainProfiles: [profile],
			variants: sources.flatMap((source) => {
				const variant =
					source.scheme === 'file' ? cargoVariant(source, workspaces, profile.id, profileOf) : undefined;
				return variant ? [variant] : [];
			}),
		};
	}
}

/** Finds Cargo on PATH, or in the `bin` folder of CARGO_HOME, where rustup installs it. */
async function findCargo(): Promise<string | undefined> {
	const onPath = await findExecutableOnPath('cargo');
	if (onPath) {
		return onPath;
	}
	const home = process.env.CARGO_HOME ?? path.join(os.homedir(), '.cargo');
	const candidate = path.join(home, 'bin', process.platform === 'win32' ? 'cargo.exe' : 'cargo');
	try {
		await fs.promises.access(candidate, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
		return candidate;
	} catch {
		return undefined;
	}
}

async function readCargoMetadata(executable: string, manifest: string): Promise<CargoWorkspace | undefined> {
	try {
		const result = await execute(
			executable,
			['metadata', '--format-version', '1', '--no-deps', '--manifest-path', manifest],
			{ cwd: path.dirname(manifest), timeoutMs: metadataTimeoutMs },
		);
		if (result.returnCode !== 0) {
			const reason =
				result.stderr
					.trim()
					.split(/\r?\n/u)
					.find((line) => line.startsWith('error')) ?? '';
			logger.logChannel.warn(`Cargo could not read ${manifest}. ${reason}`.trim());
			return undefined;
		}
		return parseCargoMetadata(result.stdout);
	} catch (error) {
		logger.logChannel.warn(`Cargo could not read ${manifest}: ${String(error)}`);
		return undefined;
	}
}
