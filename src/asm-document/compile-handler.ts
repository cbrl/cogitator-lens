import { Uri, Event, EventEmitter, window } from 'vscode';
import { CompileManager } from '../compile-database';
import { CompiledAssembly } from './compiled-assembly';
import * as logger from '../logger';


export class CompileHandler {
    public readonly srcUri: Uri;
    public readonly asmUri: Uri;

	private readonly compileManager: CompileManager;

	private readonly compileEvent: EventEmitter<CompiledAssembly | Error> = new EventEmitter();

    constructor(srcUri: Uri, asmUri: Uri, compileManager: CompileManager) {
        this.srcUri = srcUri;
        this.asmUri = asmUri;
        this.compileManager = compileManager;
    }

    public async update(): Promise<CompiledAssembly> {
		let result: CompiledAssembly | Error | undefined = undefined;

		try {
			const compileResult = await this.compileManager.compile(this.srcUri);
			result = new CompiledAssembly(this.srcUri, this.asmUri, compileResult.asm);
		}
		catch (error) {
			const errorMessage = (error instanceof Error) ? error.message : JSON.stringify(error);
			window.showErrorMessage(`Compile failed. Verify buildsystem settings and/or wait for configuration to complete. See log for error details.`);
			logger.logChannel.error(errorMessage);

			result = new Error(errorMessage);
		}

		this.compileEvent.fire(result);

		if (result instanceof Error) {
			throw result;
		}

		return result;
    }

    public dispose(): void {
        this.compileEvent.dispose();
    }

    /**
     * Event fired when the watched source file changes and is recompiled.
     */
    public get onDidChange(): Event<CompiledAssembly | Error> {
        return this.compileEvent.event;
    }
}
