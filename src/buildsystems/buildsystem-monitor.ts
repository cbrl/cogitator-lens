import { Uri, Event, EventEmitter } from 'vscode';
import { CompilationInfo } from '../compile-database';

export type BuildsystemCompileInfo = Omit<CompilationInfo, 'compilerName'> & {
	compilerPath: Uri;
};

export class BuildsystemMonitor {
	// Event to notify when compilation info changes
	protected compilationInfoEvent = new EventEmitter<[Uri, BuildsystemCompileInfo][]>();

	public get onNewCompilationInfo(): Event<[Uri, BuildsystemCompileInfo][]> {
		return this.compilationInfoEvent.event;
	}
}
