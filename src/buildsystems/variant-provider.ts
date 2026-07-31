import { Event, EventEmitter } from 'vscode';
import type { ProviderSnapshot } from '../types/index.js';

export const variantProviderDefinitions = {
	user: { label: 'Workspace' },
	cmake: { label: 'CMake' },
	'compilation-database': { label: 'Compilation database' },
	'python-environments': { label: 'Python environments' },
} as const satisfies Record<string, { readonly label: string }>;

export type ConfigurationOrigin = keyof typeof variantProviderDefinitions;

export abstract class VariantProvider {
	abstract readonly name: string;
	private readonly snapshotEmitter = new EventEmitter<ProviderSnapshot>();

	readonly onSnapshot: Event<ProviderSnapshot> = this.snapshotEmitter.event;

	protected publish(snapshot: ProviderSnapshot): void {
		this.snapshotEmitter.fire(snapshot);
	}

	abstract initialize(): Promise<void>;
	abstract refresh(): Promise<void>;

	dispose(): void {
		this.snapshotEmitter.dispose();
	}
}
