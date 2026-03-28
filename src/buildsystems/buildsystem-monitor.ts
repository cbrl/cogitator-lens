import { Uri, Event, EventEmitter } from 'vscode';
import { IBuildSystemMonitor, BuildsystemCompileInfo } from '../interfaces/index.js';

export { BuildsystemCompileInfo };

export abstract class BuildsystemMonitor implements IBuildSystemMonitor {
	abstract readonly name: string;

	protected compilationInfoEvent = new EventEmitter<[Uri, BuildsystemCompileInfo][]>();

	public get onCompilationInfoChanged(): Event<[Uri, BuildsystemCompileInfo][]> {
		return this.compilationInfoEvent.event;
	}

	abstract initialize(): Promise<void>;
	abstract refresh(): Promise<void>;

	dispose(): void {
		this.compilationInfoEvent.dispose();
	}
}
