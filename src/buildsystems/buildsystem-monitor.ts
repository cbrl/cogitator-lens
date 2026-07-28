import { Event, EventEmitter } from 'vscode';
import type { IBuildSystemMonitor } from '../interfaces/index.js';
import type { ProviderSnapshot } from '../types/index.js';

export abstract class BuildsystemMonitor implements IBuildSystemMonitor {
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
