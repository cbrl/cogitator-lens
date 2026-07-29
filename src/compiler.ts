import fs from 'fs';
import path from 'path';
import type { CancellationToken } from 'vscode';
import { AsmParser } from './parsers/asm-parser.js';
import * as exec from './exec.js';
import type {
	CompilerOutputOptions,
	ParseFiltersAndOutputOptions,
} from './parsers/filters.interfaces.js';
import type { ParsedAsmResult } from './parsers/asmresult.interfaces.js';
import type { CompilerProfile, CompileOptions } from './types/index.js';
import { redactArguments, sanitizeCompilerArguments } from './compiler-arguments.js';
import { withTemporaryDirectory } from './temporary-directory.js';

export interface CompilerRunResult {
	rawAssembly: string;
	stdout: string;
	stderr: string;
	durationMs: number;
	truncated: boolean;
	command: {
		executable: string;
		arguments: readonly string[];
		environmentVariableNames: readonly string[];
		workingDirectory: string;
	};
}

export class CompilerExitError extends Error {
	constructor(
		message: string,
		public readonly returnCode: number,
		public readonly stdout: string,
		public readonly stderr: string,
	) {
		super(message);
		this.name = 'CompilerExitError';
	}
}

export interface ICompiler {
	readonly profile: CompilerProfile;
	compile(
		file: string,
		options: CompileOptions,
		cancellationToken: CancellationToken,
	): Promise<CompilerRunResult>;
	parseAssembly(rawAssembly: string, filters: ParseFiltersAndOutputOptions): ParsedAsmResult;
}

export abstract class CompilerBase implements ICompiler {
	readonly profile: CompilerProfile;
	protected asmParser: AsmParser;

	constructor(profile: CompilerProfile) {
		this.profile = profile;
		this.asmParser = new AsmParser();
	}

	async compile(
		file: string,
		options: CompileOptions,
		cancellationToken: CancellationToken,
	): Promise<CompilerRunResult> {
		return withTemporaryDirectory('coglens-', async temporaryDirectory => {
			const outputFile = path.join(temporaryDirectory, 'output.asm');
			const workingDirectory = options.workingDirectory ?? path.dirname(file);

			const environment = {
				...process.env,
				...this.profile.environment,
				...options.env,
			};

			const providerArguments = sanitizeCompilerArguments([
				...this.profile.defaultArguments,
				...(options.args ?? []),
			], file, workingDirectory);
			const outputOptions = options.outputOptions ?? {};

			const argumentsList = [
				...providerArguments,
				...this.profile.includes.map(value => `${this.profile.includeFlag}${value}`),
				...(options.includes ?? []).map(value => `${this.profile.includeFlag}${value}`),
				...this.profile.defines.map(value => `${this.profile.defineFlag}${value}`),
				...(options.defines ?? []).map(value => `${this.profile.defineFlag}${value}`),
				...this.outputOptionArguments(outputOptions),
				...this.prepareArguments(outputFile),
				file,
			];

			const started = performance.now();
			const { logChannel } = await import('./logger.js');
			logChannel.info(`Compiling ${file} with ${this.profile.displayName}`);
			logChannel.info(`Command: ${this.profile.executable} ${redactArguments(argumentsList).join(' ')}`);
			const overriddenNames = Object.keys({ ...this.profile.environment, ...options.env }).sort();
			logChannel.debug(`Environment overrides: ${overriddenNames.join(', ') || '(none)'}`);

			const result = await this.runCompiler(argumentsList, environment, workingDirectory, cancellationToken);
			if (result.returnCode !== 0) {
				throw new CompilerExitError(
					`Compiler exited with code ${result.returnCode}`,
					result.returnCode,
					result.stdout,
					result.stderr,
				);
			}

			const assembly = await fs.promises.readFile(outputFile, 'utf8');
			const postProcessedAssembly = await this.postProcessAssembly(
				assembly,
				outputOptions,
				environment,
				workingDirectory,
				cancellationToken,
			);
			return {
				rawAssembly: postProcessedAssembly,
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

	parseAssembly(rawAssembly: string, filters: ParseFiltersAndOutputOptions): ParsedAsmResult {
		return this.asmParser.process(rawAssembly, filters);
	}

	protected runCompiler(
		args: readonly string[],
		environment: NodeJS.ProcessEnv,
		workingDirectory: string,
		cancellationToken: CancellationToken,
	): Promise<exec.ExecResult> {
		return exec.execute(this.profile.executable, args, {
			cwd: workingDirectory,
			env: environment,
			cancellationToken,
		});
	}

	protected abstract prepareArguments(outputFile: string): readonly string[];

	protected outputOptionArguments(_options: CompilerOutputOptions): readonly string[] {
		return [];
	}

	protected async postProcessAssembly(
		rawAssembly: string,
		options: CompilerOutputOptions,
		environment: NodeJS.ProcessEnv,
		workingDirectory: string,
		cancellationToken: CancellationToken,
	): Promise<string> {
		if (!options.demangle || !this.profile.capabilities.demangle || !this.profile.demangler) {
			return rawAssembly;
		}

		const result = await exec.execute(this.profile.demangler, [], {
			cwd: workingDirectory,
			env: environment,
			cancellationToken,
			stdin: rawAssembly,
		});
		if (result.returnCode !== 0) {
			throw new CompilerExitError(
				`Demangler exited with code ${result.returnCode}`,
				result.returnCode,
				result.stdout,
				result.stderr,
			);
		}
		return result.stdout;
	}
}
