import * as processExecution from './exec.js';
import type { ExecOptions, ExecResult } from './exec.js';

export type { ExecOptions, ExecResult };
export { ExecError } from './exec.js';

export class WorkspaceTrustError extends Error {
	constructor() {
		super('Toolchain execution is disabled because this workspace is not trusted.');
		this.name = 'WorkspaceTrustError';
	}
}

/**
 * The sole process-execution chokepoint for extension code.
 *
 * Keeping the trust predicate injected makes the policy independently testable
 * and keeps the low-level spawn helper free of VS Code imports.
 */
export class ToolExecutionGate {
	constructor(private readonly isTrusted: () => boolean) {}

	execute(
		command: string,
		args: readonly string[],
		options: ExecOptions = {},
	): Promise<ExecResult> {
		if (!this.isTrusted()) {
			throw new WorkspaceTrustError();
		}
		return processExecution.execute(command, args, options);
	}
}

export const trustedToolExecution = new ToolExecutionGate(() => true);
