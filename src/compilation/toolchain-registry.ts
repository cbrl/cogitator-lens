import { Disposable, Event, EventEmitter } from 'vscode';
import type { IToolchainRegistry } from '../interfaces/index.js';
import type {
	ArtifactKind,
	ArtifactOptionAvailability,
	ToolchainProfile,
	ReconciliationChange,
} from '../types/index.js';
import { ToolchainBackend } from '../toolchains/toolchain-backend.js';
import {
	getToolchainDefinition,
	resolveArtifactAvailability,
} from '../toolchains/toolchain-map.js';
import type { ConfigurationOrigin } from '../buildsystems/variant-provider.js';
import {
	ToolExecutionGate,
	trustedToolExecution,
} from '../tool-execution.js';

interface RegistryEntry {
	origin: ConfigurationOrigin;
	profile: ToolchainProfile;
	backend: ToolchainBackend;
}

export class ToolchainRegistry implements IToolchainRegistry, Disposable {
	private readonly entries = new Map<string, RegistryEntry>();
	private readonly changeEmitter = new EventEmitter<ReconciliationChange<ToolchainProfile>>();

	readonly onDidChange: Event<ReconciliationChange<ToolchainProfile>> = this.changeEmitter.event;

	constructor(private readonly execution: ToolExecutionGate = trustedToolExecution) {}

	getProfiles(origin?: ConfigurationOrigin): readonly ToolchainProfile[] {
		return [...this.entries.values()]
			.filter(entry => origin === undefined || entry.origin === origin)
			.map(entry => entry.profile);
	}

	getToolchainById(id: string): ToolchainBackend | undefined {
		return this.entries.get(id)?.backend;
	}

	findToolchainByDisplayName(displayName: string): ToolchainBackend | undefined {
		return [...this.entries.values()]
			.find(entry => entry.profile.displayName === displayName)
			?.backend;
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

	reconcile(origin: ConfigurationOrigin, profiles: readonly ToolchainProfile[]): ReconciliationChange<ToolchainProfile> {
		const canonicalProfiles = profiles.map(profile => ({
			...profile,
			id: ToolchainRegistry.profileId(origin, profile.id),
		}));
		const next = new Map(canonicalProfiles.map(profile => [profile.id, profile]));
		const added: ToolchainProfile[] = [];
		const updated: ToolchainProfile[] = [];
		const removed: ToolchainProfile[] = [];

		for (const [id, entry] of this.entries) {
			if (entry.origin !== origin) {
				continue;
			}
			const replacement = next.get(id);
			if (!replacement) {
				this.entries.delete(id);
				removed.push(entry.profile);
			} else if (!profilesEqual(entry.profile, replacement)) {
				this.entries.set(id, this.createEntry(origin, replacement));
				updated.push(replacement);
			}
			next.delete(id);
		}

		for (const profile of next.values()) {
			this.entries.set(profile.id, this.createEntry(origin, profile));
			added.push(profile);
		}

		const change = { added, updated, removed };
		if (added.length || updated.length || removed.length) {
			this.changeEmitter.fire(change);
		}
		return change;
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
		if (!definition) {
			throw new Error(`Unsupported toolchain kind: ${profile.kind}`);
		}
		return {
			origin,
			profile,
			backend: new definition.Adapter(profile, definition.capabilities, this.execution),
		};
	}
}

function profilesEqual(left: ToolchainProfile, right: ToolchainProfile): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}
