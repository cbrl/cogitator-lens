import { Disposable, Event, EventEmitter } from 'vscode';
import type { ArtifactKind, ArtifactOptionAvailability, ToolchainProfile } from '../types/index.js';
import { ToolchainBackend } from '../toolchains/toolchain-backend.js';
import { getToolchainDefinition } from '../toolchains/toolchain-map.js';
import { resolveArtifactAvailability } from '../toolchains/toolchain-artifacts.js';
import type { ConfigurationOrigin } from '../buildsystems/variant-provider.js';
import { structurallyEqual } from '../utils.js';
import { logChannel } from '../logger.js';

interface RegistryEntry {
	origin: ConfigurationOrigin;
	profile: ToolchainProfile;
	backend: ToolchainBackend;
}

export class ToolchainRegistry implements Disposable {
	private readonly entries = new Map<string, RegistryEntry>();
	private readonly changeEmitter = new EventEmitter<void>();

	readonly onDidChange: Event<void> = this.changeEmitter.event;

	getProfiles(origin?: ConfigurationOrigin): readonly ToolchainProfile[] {
		return [...this.entries.values()]
			.filter((entry) => origin === undefined || entry.origin === origin)
			.map((entry) => entry.profile);
	}

	getToolchainById(id: string): ToolchainBackend | undefined {
		return this.entries.get(id)?.backend;
	}

	findToolchainByDisplayName(displayName: string): ToolchainBackend | undefined {
		return [...this.entries.values()].find((entry) => entry.profile.displayName === displayName)?.backend;
	}

	getArtifactAvailability(id: string, kind: ArtifactKind): ArtifactOptionAvailability {
		const backend = this.getToolchainById(id);
		if (!backend) {
			return {
				status: 'unavailable',
				explanation: `Toolchain profile not found: ${id}`,
			};
		}
		const cell = resolveArtifactAvailability(backend.profile, kind);
		return cell.status === 'available' ? { status: 'available' } : cell;
	}

	getOrigin(id: string): ConfigurationOrigin | undefined {
		return this.entries.get(id)?.origin;
	}

	reconcile(origin: ConfigurationOrigin, profiles: readonly ToolchainProfile[]): boolean {
		const canonicalProfiles = profiles.map((profile) => ({
			...profile,
			id: ToolchainRegistry.profileId(origin, profile.id),
		}));
		const next = new Map(canonicalProfiles.map((profile) => [profile.id, profile]));
		let changed = false;

		for (const [id, entry] of this.entries) {
			if (entry.origin !== origin) {
				continue;
			}
			const replacement = next.get(id);
			if (!replacement) {
				this.entries.delete(id);
				changed = true;
			} else if (!structurallyEqual(entry.profile, replacement)) {
				this.entries.set(id, this.createEntry(origin, replacement));
				changed = true;
			}
			next.delete(id);
		}

		for (const profile of next.values()) {
			this.entries.set(profile.id, this.createEntry(origin, profile));
			changed = true;
		}

		if (changed) {
			this.changeEmitter.fire();
		}
		return changed;
	}

	dispose(): void {
		this.changeEmitter.dispose();
		this.entries.clear();
	}

	static profileId(origin: ConfigurationOrigin, localId: string): string {
		return `${origin}:${localId}`;
	}

	private createEntry(origin: ConfigurationOrigin, profile: ToolchainProfile): RegistryEntry {
		const definition = getToolchainDefinition(profile.kind);
		return {
			origin,
			profile,
			backend: new ToolchainBackend(profile, definition, {
				log(message, level = 'info') {
					logChannel[level](message);
				},
			}),
		};
	}
}
