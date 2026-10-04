import { Disposable, Event, EventEmitter } from 'vscode';
import type { ProviderSnapshot } from '../types/index.js';

export const variantProviderDefinitions = {
	user: { label: 'Workspace' },
	cmake: { label: 'CMake' },
	'compilation-database': { label: 'Compilation database' },
	'python-environments': { label: 'Python environments' },
} as const satisfies Record<string, { readonly label: string }>;

export type ConfigurationOrigin = keyof typeof variantProviderDefinitions;

/** The variants of a provider and the toolchain profiles they use. */
export type VariantSnapshot = Omit<ProviderSnapshot, 'provider'>;

export const emptySnapshot: VariantSnapshot = { toolchainProfiles: [], variants: [] };

/** Joins partial snapshots and keeps one toolchain profile for each ID. */
export function mergeSnapshots(parts: readonly VariantSnapshot[]): VariantSnapshot {
	const profiles = new Map(parts.flatMap((part) => part.toolchainProfiles).map((profile) => [profile.id, profile]));
	return { toolchainProfiles: [...profiles.values()], variants: parts.flatMap((part) => part.variants) };
}

/** Discovers compilation variants from one external source and publishes them as snapshots. */
export abstract class VariantProvider {
	private readonly snapshotEmitter = new EventEmitter<ProviderSnapshot>();
	private refreshGeneration = 0;
	protected disposed = false;
	/** Disposed together with the provider. */
	protected readonly subscriptions: Disposable[] = [];

	readonly onSnapshot: Event<ProviderSnapshot> = this.snapshotEmitter.event;

	constructor(protected readonly providerId: ConfigurationOrigin) {}

	abstract initialize(): Promise<void>;

	/** Reads the current variants of the provider. */
	protected abstract read(): Promise<VariantSnapshot>;

	/** Reads and publishes the variants, unless a newer refresh starts first. */
	async refresh(): Promise<void> {
		const generation = ++this.refreshGeneration;
		const snapshot = await this.read();
		if (!this.disposed && generation === this.refreshGeneration) {
			this.publish(snapshot);
		}
	}

	protected publish(snapshot: VariantSnapshot): void {
		this.snapshotEmitter.fire({ provider: this.providerId, ...snapshot });
	}

	dispose(): void {
		this.disposed = true;
		this.refreshGeneration++;
		this.subscriptions.splice(0).forEach((subscription) => subscription.dispose());
		this.snapshotEmitter.dispose();
	}
}
