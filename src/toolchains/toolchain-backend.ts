import fs from 'fs';
import path from 'path';
import type { CancellationToken } from 'vscode';
import { AsmParser } from '../parsers/asm-parser.js';
import type { ParseFiltersAndOutputOptions } from '../parsers/filters.interfaces.js';
import type { ParsedAsmResult } from '../parsers/asmresult.interfaces.js';
import type {
	ToolchainProfile,
	ToolchainCapabilities,
	CompileOptions,
	DisplayOptions,
	ProductionOptions,
	RawArtifact,
} from '../types/index.js';
import { redactArguments } from '../toolchain-arguments.js';
import { sanitizeAssemblyArguments } from '../artifacts/assembly-producer.js';
import {
	ToolExecutionGate,
	trustedToolExecution,
	type ExecResult,
} from '../tool-execution.js';
import { withTemporaryDirectory } from '../temporary-directory.js';

export class ToolExitError extends Error {
	constructor(
		message: string,
		public readonly returnCode: number,
		public readonly stdout: string,
		public readonly stderr: string,
	) {
		super(message);
		this.name = 'ToolExitError';
	}
}

export interface AssemblyToolOutput extends RawArtifact {
	readonly stdout: string;
	readonly stderr: string;
}

export interface IToolchainBackend {
	readonly profile: ToolchainProfile;
	produceAssembly(
		file: string,
		options: CompileOptions,
		cancellationToken: CancellationToken,
	): Promise<AssemblyToolOutput>;
	parseAssembly(rawAssembly: string, options: DisplayOptions): ParsedAsmResult;
}

export abstract class ToolchainBackend implements IToolchainBackend {
	readonly profile: ToolchainProfile;
	protected asmParser: AsmParser;
	protected readonly capabilities: ToolchainCapabilities;

	constructor(
		profile: ToolchainProfile,
		capabilities: ToolchainCapabilities,
		protected readonly execution: ToolExecutionGate = trustedToolExecution,
	) {
		this.profile = profile;
		this.capabilities = capabilities;
		this.asmParser = new AsmParser();
	}

	async produceAssembly(
		file: string,
		options: CompileOptions,
		cancellationToken: CancellationToken,
	): Promise<AssemblyToolOutput> {
		return withTemporaryDirectory('coglens-', async temporaryDirectory => {
			const outputFile = path.join(temporaryDirectory, 'output.asm');
			const workingDirectory = options.workingDirectory ?? path.dirname(file);

			const environment = {
				...process.env,
				...this.profile.environment,
				...options.env,
			};

			const providerArguments = sanitizeAssemblyArguments([
				...this.profile.defaultArguments,
				...(options.args ?? []),
			], file, workingDirectory);
			const argumentsList = [
				...providerArguments,
				...this.outputOptionArguments(options.productionOptions),
				...this.prepareArguments(outputFile),
				file,
			];

			const started = performance.now();
			const { logChannel } = await import('../logger.js');
			logChannel.info(`Compiling ${file} with ${this.profile.displayName}`);
			logChannel.info(`Command: ${this.profile.executable} ${redactArguments(argumentsList).join(' ')}`);
			const overriddenNames = Object.keys({ ...this.profile.environment, ...options.env }).sort();
			logChannel.debug(`Environment overrides: ${overriddenNames.join(', ') || '(none)'}`);

			const result = await this.runCompiler(argumentsList, environment, workingDirectory, cancellationToken);
			if (result.returnCode !== 0) {
				throw new ToolExitError(
					`Toolchain exited with code ${result.returnCode}`,
					result.returnCode,
					result.stdout,
					result.stderr,
				);
			}

			const assembly = await fs.promises.readFile(outputFile, 'utf8');
			const postProcessedAssembly = await this.postProcessAssembly(
				assembly,
				options.productionOptions,
				environment,
				workingDirectory,
				cancellationToken,
			);
			return {
				kind: 'assembly',
				text: postProcessedAssembly,
				diagnostics: [],
				stdout: result.stdout,
				stderr: result.stderr,
				durationMs: performance.now() - started,
				truncated: false,
				command: {
					executable: this.profile.executable,
					arguments: redactArguments(argumentsList),
					environmentVariableNames: overriddenNames,
					workingDirectory,
				},
			};
		});
	}

	parseAssembly(rawAssembly: string, options: DisplayOptions): ParsedAsmResult {
		const filters: ParseFiltersAndOutputOptions = { ...options };
		return this.asmParser.process(rawAssembly, {
			...filters,
			libraryCode: this.capabilities.libraryCodeFilter
				? filters.libraryCode
				: false,
		});
	}

	protected runCompiler(
		args: readonly string[],
		environment: NodeJS.ProcessEnv,
		workingDirectory: string,
		cancellationToken: CancellationToken,
	): Promise<ExecResult> {
		return this.execution.execute(this.profile.executable, args, {
			cwd: workingDirectory,
			env: environment,
			cancellationToken,
		});
	}

	protected abstract prepareArguments(outputFile: string): readonly string[];

	protected outputOptionArguments(_options: ProductionOptions): readonly string[] {
		return [];
	}

	protected async postProcessAssembly(
		rawAssembly: string,
		options: ProductionOptions,
		environment: NodeJS.ProcessEnv,
		workingDirectory: string,
		cancellationToken: CancellationToken,
	): Promise<string> {
		if (
			!options.demangle
			|| !this.capabilities.demangle
			|| !this.profile.tools.demangler
		) {
			return rawAssembly;
		}

		const result = await this.execution.execute(this.profile.tools.demangler, [], {
			cwd: workingDirectory,
			env: environment,
			cancellationToken,
			stdin: rawAssembly,
		});
		if (result.returnCode !== 0) {
			throw new ToolExitError(
				`Demangler exited with code ${result.returnCode}`,
				result.returnCode,
				result.stdout,
				result.stderr,
			);
		}
		return result.stdout;
	}
}
