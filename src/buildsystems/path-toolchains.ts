import { commands, workspace } from 'vscode';
import type { ConfigurationService } from '../services/configuration-service.js';
import { detectPathToolchains } from '../toolchains/path-detection.js';
import * as logger from '../logger.js';
import { emptySnapshot, VariantProvider, type VariantSnapshot } from './variant-provider.js';

/**
 * Publishes the compilers and interpreters found on PATH as toolchain profiles. They have no
 * variants of their own; the compilation service uses them for files that have no other variant.
 */
export class PathToolchainProvider extends VariantProvider {
	private runningDetections = 0;

	constructor(private readonly configuration: ConfigurationService) {
		super('path');
	}

	async initialize(): Promise<void> {
		this.subscriptions.push(
			workspace.onDidChangeConfiguration((event) => {
				if (event.affectsConfiguration('coglens.detectToolchainsOnPath')) {
					void this.refresh();
				}
			}),
		);
		await this.refresh();
	}

	protected async read(): Promise<VariantSnapshot> {
		if (!this.configuration.getDetectToolchainsOnPath()) {
			return emptySnapshot;
		}
		this.setDetectionContext(++this.runningDetections);
		try {
			const toolchainProfiles = await detectPathToolchains();
			logger.logChannel.info(
				toolchainProfiles.length > 0
					? `Toolchains found on PATH: ${toolchainProfiles.map((profile) => `${profile.displayName} (${profile.executable})`).join(', ')}`
					: 'No supported toolchains were found on PATH.',
			);
			return { toolchainProfiles, variants: [] };
		} finally {
			this.setDetectionContext(--this.runningDetections);
		}
	}

	private setDetectionContext(running: number): void {
		void commands.executeCommand('setContext', 'coglens.toolchainDetection', running > 0 ? 'running' : 'done');
	}
}
