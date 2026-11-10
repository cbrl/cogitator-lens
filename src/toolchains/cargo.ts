import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CancellationToken } from 'vscode';
import { parseMakeDepfile } from '../compilation/artifact-inputs.js';
import { ExecError } from '../exec.js';
import {
	pipelineProducer,
	rustPassDumpArguments,
	type PipelineArguments,
} from '../artifacts/optimization-pipeline/pipeline-producer.js';
import { machineCodeAnalysis } from '../artifacts/machine-code-analysis/analysis-producer.js';
import { outputProducer } from '../artifacts/core/compiler-output-producer.js';
import { renderRustOptimizationRemarks } from '../artifacts/optimization-remarks/rust-optimization-remarks.js';
import { parseRustMirControlFlowGraphs } from '../artifacts/control-flow-graph/parsers/rust-mir-cfg-parser.js';
import { parseLlvmControlFlowGraphs } from '../artifacts/control-flow-graph/parsers/llvm-ir-cfg-parser.js';
import { ClangAssemblyCfgParser } from '../artifacts/control-flow-graph/parsers/assembly-dialects.js';
import { InstructionSetInfo } from '../artifacts/control-flow-graph/parsers/instruction-sets.js';
import { ToolExitError, type ArtifactOutputSpec, type DependencyCollectionSpec } from './toolchain-backend.js';
import {
	compilerAssembly,
	assemblyControlFlowGraphOutput,
	controlFlowGraphOutput,
	toolDiscoverer,
	type InvocationRunner,
	type ToolchainDefinition,
	withoutOwnedArguments,
} from './toolchain-contracts.js';
import { defaultAsmParser } from './c-family.js';
import { parseRustDiagnostics } from './rust/diagnostics.js';
import { rustOptimizationLevels } from './optimization-levels.js';
import { stripRustManagedArguments } from './rust.js';

/** Cargo reads the arguments before this one, and it gives the arguments after it to rustc. */
export const endOfCargoOptions = '--';

const cargoSubcommands = new Set(['rustc', 'build', 'check']);
const cargoManagedFlagsWithValues = new Set(['--message-format', '--color']);
const cargoManagedFlags = /^(?:--message-format=|--color=|-q$|--quiet$|-v+$|--verbose$)/u;

/**
 * Splits the arguments at the first `--`. Without one, each argument is a Cargo option, so the
 * arguments of a variant end with `--`, and the arguments that follow them go to rustc.
 */
export function splitCargoArguments(args: readonly string[]): {
	readonly cargo: readonly string[];
	readonly rustc: readonly string[];
} {
	const end = args.indexOf(endOfCargoOptions);
	return end < 0 ? { cargo: args, rustc: [] } : { cargo: args.slice(0, end), rustc: args.slice(end + 1) };
}

/**
 * Removes the subcommand, the output format, and the source from the Cargo options, and the
 * arguments that the Rust backend owns from the rustc arguments.
 */
export function stripCargoManagedArguments(
	args: readonly string[],
	sourceFile: string,
	workingDirectory?: string,
): string[] {
	const { cargo, rustc } = splitCargoArguments(args);
	return [
		...withoutOwnedArguments(cargo, sourceFile, workingDirectory, {
			withValue: [cargoManagedFlagsWithValues],
			standalone: [cargoManagedFlags, (argument, index) => index === 0 && cargoSubcommands.has(argument)],
		}),
		endOfCargoOptions,
		...stripRustManagedArguments(rustc, sourceFile, workingDirectory),
	];
}

/**
 * Runs `cargo rustc`. Cargo compiles the root of the selected target, so the command does not name
 * the source: a module file compiles with its crate. The arguments of the artifact go to rustc.
 * Cargo shows the diagnostics as text, and it writes a JSON message for each compiled package.
 */
export const assembleCargoArguments: NonNullable<ToolchainDefinition['assembleArguments']> = (owned, provider) => {
	const { cargo, rustc } = splitCargoArguments(provider);
	return [
		'rustc',
		...cargo,
		'--color',
		'never',
		'--message-format',
		'json-render-diagnostics',
		endOfCargoOptions,
		...rustc,
		...owned,
	];
};

/** Separates the JSON messages of Cargo from the other lines of its standard output. */
export function cargoMessages(stdout: string): { readonly messages: readonly unknown[]; readonly text: string } {
	const messages: unknown[] = [];
	const lines: string[] = [];
	for (const line of stdout.split(/\r?\n/u)) {
		if (line.startsWith('{')) {
			try {
				messages.push(JSON.parse(line));
				continue;
			} catch {
				// A line that is not a message stays in the text.
			}
		}
		lines.push(line);
	}
	return { messages, text: lines.join('\n') };
}

/**
 * The dep-info files of the local packages that the messages name, such as a path dependency in the
 * workspace. Cargo writes each one beside the library, with the hash of the library in its name. The
 * dep-info of rustc for the target does not list the files of these packages.
 */
export function localDependencyInfoFiles(messages: readonly unknown[]): string[] {
	const files = new Set<string>();
	for (const message of messages) {
		const artifact = message as {
			reason?: unknown;
			package_id?: unknown;
			target?: { name?: unknown };
			filenames?: unknown;
		};
		const name = artifact.target?.name;
		if (
			artifact.reason !== 'compiler-artifact' ||
			typeof artifact.package_id !== 'string' ||
			!artifact.package_id.includes('path+file://') ||
			typeof name !== 'string' ||
			!Array.isArray(artifact.filenames)
		) {
			continue;
		}
		for (const filename of artifact.filenames) {
			const hash = typeof filename === 'string' ? /-([0-9a-f]{16})\.[^.\\/]+$/u.exec(filename)?.[1] : undefined;
			if (hash) {
				files.add(path.join(path.dirname(filename as string), `${name.replaceAll('-', '_')}-${hash}.d`));
			}
		}
	}
	return [...files];
}

const dependencyInfoEmit = '--emit=dep-info=';

/** Adds the dep-info files of the local dependencies to the dep-info file of the arguments. */
async function addLocalDependencies(args: readonly string[], dependencyInfoFiles: readonly string[]): Promise<void> {
	const { rustc } = splitCargoArguments(args);
	const dependencyFile = [...rustc]
		.reverse()
		.find((argument) => argument.startsWith(dependencyInfoEmit))
		?.slice(dependencyInfoEmit.length);
	if (!dependencyFile || dependencyInfoFiles.length === 0 || !fs.existsSync(dependencyFile)) {
		return;
	}
	const texts = await Promise.all(
		dependencyInfoFiles.map((file) => fs.promises.readFile(file, 'utf8').catch(() => '')),
	);
	await fs.promises.appendFile(dependencyFile, texts.map((text) => `\n${text}`).join(''));
}

/**
 * Cargo gives rustc its own output and diagnostic options, so these arguments only add an output.
 * The `--emit` form with a file name keeps the outputs of Cargo where Cargo expects them, which
 * `-o` does not.
 */
function emit(kind: 'asm' | 'obj' | 'llvm-ir' | 'mir' | 'dep-info', outputFile: string): string {
	return `--emit=${kind}=${outputFile}`;
}

export function cargoOutputArguments(target: 'assembly' | 'object', outputFile: string): readonly string[] {
	return [emit(target === 'assembly' ? 'asm' : 'obj', outputFile), '-C', 'debuginfo=1'];
}

export const cargoLlvmIrOutput: ArtifactOutputSpec = Object.freeze({
	output: { filename: 'output.ll' },
	arguments: (outputFile: string) => [emit('llvm-ir', outputFile), '-C', 'debuginfo=1'],
});

export const cargoMirOutput: ArtifactOutputSpec = Object.freeze({
	output: { filename: 'output.mir' },
	arguments: (outputFile: string) => [emit('mir', outputFile)],
});

/** Cargo builds the crate, so the code generator runs and prints the remarks without an output. */
export const cargoOptimizationRemarksOutput: ArtifactOutputSpec = Object.freeze({
	output: 'stderr',
	arguments: () => ['-C', 'debuginfo=1', '-C', 'remark=all'],
	outputDiagnostics: (text: string) => text,
});

/** Cargo builds the crate, so each pass of the code generator runs without an output. */
const cargoPipelineArguments: PipelineArguments = (functionFilter) => rustPassDumpArguments(functionFilter);

/**
 * The dep-info file of rustc lists the files of the crate and of its path dependencies. With this
 * file name, Cargo 1.97 does not find its own dep-info of the target. It then compiles the target
 * at each run, but not its dependencies, so each run writes all of its outputs.
 */
const cargoDependencyCollection: DependencyCollectionSpec = Object.freeze({
	outputFilename: 'dependencies.d',
	inlineArguments: (outputFile: string) => [emit('dep-info', outputFile)],
	parse: parseMakeDepfile,
});

/** The runs of each output directory, so that one run at a time uses the files of a directory. */
const outputDirectoryRuns = new Map<string, Promise<void>>();

/**
 * The folder of the output directories of this user. On Linux, all users share the temporary
 * folder, so the name of the folder has the user ID.
 */
export function cargoRunsFolder(): string {
	return path.join(os.tmpdir(), `coglens-cargo-${process.getuid?.() ?? os.userInfo().username}`);
}

/**
 * The directory of the outputs of the arguments, which is the same for each run of them. Cargo puts
 * the rustc arguments into the file names of its outputs, so a new temporary directory in the
 * arguments makes new files at each run. The files then fill the target directory. Cargo also keeps
 * the error output of each target in the target directory, and a pass dump can be gigabytes.
 */
export function cargoOutputDirectory(args: readonly string[], temporaryDirectory: string): string {
	const key = crypto
		.createHash('sha256')
		.update(JSON.stringify(args.map((argument) => argument.split(temporaryDirectory).join('\0'))))
		.digest('hex')
		.slice(0, 16);
	return path.join(cargoRunsFolder(), key);
}

/**
 * Makes the folder of the output directories. Only its owner can open it. A folder of another
 * user, or a link, stops the run, because another user could then change the outputs.
 */
async function makeRunsFolder(folder: string): Promise<void> {
	await fs.promises.mkdir(folder, { recursive: true, mode: 0o700 });
	const stats = await fs.promises.lstat(folder);
	const user = process.getuid?.();
	if (!stats.isDirectory() || (user !== undefined && stats.uid !== user)) {
		throw new Error(`The Cargo output folder ${folder} belongs to another user. Remove it, then compile again.`);
	}
}

/** The time between two checks of a lock file that another process has. */
const lockRetryMilliseconds = 100;
/** A lock file older than this is free, also when its process ID is in use again. */
const staleLockMilliseconds = 60 * 60 * 1000;

function processRuns(processId: number): boolean {
	try {
		process.kill(processId, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'EPERM';
	}
}

/**
 * Takes the lock file of an output directory, and waits while another process has it. Each VS Code
 * window has its own extension host, so two windows can compile the same target at the same time.
 * The lock file holds the process ID of its owner. The lock of a process that stopped is free.
 * Returns the function that frees the lock.
 */
export async function lockOutputDirectory(
	directory: string,
	cancellationToken: CancellationToken,
): Promise<() => Promise<void>> {
	const lockFile = `${directory}.lock`;
	for (;;) {
		if (cancellationToken.isCancellationRequested) {
			throw new ExecError(
				'cancelled',
				'The compile was cancelled while another window compiled the same target.',
			);
		}
		try {
			await fs.promises.writeFile(lockFile, String(process.pid), { flag: 'wx' });
			return () => fs.promises.rm(lockFile, { force: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
				throw error;
			}
		}
		const owner = Number.parseInt(await fs.promises.readFile(lockFile, 'utf8').catch(() => ''), 10);
		const modified = (await fs.promises.stat(lockFile).catch(() => undefined))?.mtimeMs ?? Date.now();
		// This process takes the lock of a directory once at a time, so its own ID in the file is old.
		const free =
			Date.now() - modified > staleLockMilliseconds ||
			(owner > 0 && (owner === process.pid || !processRuns(owner)));
		if (free) {
			await fs.promises.rm(lockFile, { force: true });
			continue;
		}
		await new Promise((resolve) => setTimeout(resolve, lockRetryMilliseconds));
	}
}

/**
 * Runs Cargo with its outputs in the directory of the arguments, then moves them to the temporary
 * directory of the run, where the backend reads them. The JSON messages of Cargo give the files of
 * the local dependencies, and they do not go into the output that the user sees.
 */
export const runCargoInvocation: InvocationRunner = async ({
	arguments: args,
	temporaryDirectory,
	execute,
	log,
	cancellationToken,
}) => {
	const directory = cargoOutputDirectory(args, temporaryDirectory);
	const runArguments = args.map((argument) => argument.split(temporaryDirectory).join(directory));
	return oneRunAtATime(directory, async () => {
		await makeRunsFolder(path.dirname(directory));
		const unlock = await lockOutputDirectory(directory, cancellationToken);
		try {
			await fs.promises.rm(directory, { recursive: true, force: true });
			await fs.promises.mkdir(directory);
			log(`Cargo writes the outputs to ${directory}, so that each run has the same arguments.`);
			const result = await execute(runArguments);
			const { messages, text } = cargoMessages(result.stdout);
			await addLocalDependencies(runArguments, localDependencyInfoFiles(messages));
			await fs.promises.cp(directory, temporaryDirectory, { recursive: true });
			return { ...result, stdout: text };
		} catch (error) {
			throw error instanceof ToolExitError
				? new ToolExitError(error.message, error.returnCode, cargoMessages(error.stdout).text, error.stderr)
				: error;
		} finally {
			await fs.promises.rm(directory, { recursive: true, force: true }).catch(() => undefined);
			await unlock().catch(() => undefined);
		}
	});
};

async function oneRunAtATime<T>(key: string, action: () => Promise<T>): Promise<T> {
	const previous = outputDirectoryRuns.get(key) ?? Promise.resolve();
	const run = previous.then(action);
	const settled = run.then(
		() => undefined,
		() => undefined,
	);
	outputDirectoryRuns.set(key, settled);
	try {
		return await run;
	} finally {
		if (outputDirectoryRuns.get(key) === settled) {
			outputDirectoryRuns.delete(key);
		}
	}
}

export const cargo: ToolchainDefinition = {
	executablePattern: /^cargo(?:\.exe)?$/i,
	parseDiagnostics: parseRustDiagnostics,
	languageIdentifiers: Object.freeze(['rust']),
	optimizationLevels: rustOptimizationLevels,
	intelSyntax: 'selectable',
	intelArguments: Object.freeze(['-C', 'llvm-args=-x86-asm-syntax=intel']),
	defineFlag: '--cfg=',
	objectFilename: 'output.o',
	outputArguments: cargoOutputArguments,
	assembleArguments: assembleCargoArguments,
	stripOwnedArguments: stripCargoManagedArguments,
	dependencyCollection: cargoDependencyCollection,
	runInvocation: runCargoInvocation,
	createParser: defaultAsmParser,
	createCfgParser: () => new ClangAssemblyCfgParser(new InstructionSetInfo()),
	discoverTools: toolDiscoverer({ demangler: 'rustfilt', analyzer: 'llvm-mca' }),
	artifacts: {
		assembly: compilerAssembly,
		'llvm-ir': { producer: outputProducer(cargoLlvmIrOutput) },
		'rust-mir': { producer: outputProducer(cargoMirOutput) },
		'optimization-remarks': {
			producer: outputProducer(cargoOptimizationRemarksOutput),
			renderer: renderRustOptimizationRemarks,
		},
		'control-flow-graph': {
			outputs: [
				controlFlowGraphOutput(
					'rust-mir',
					'Rust MIR CFG',
					'Build a source-level graph from rustc MIR output.',
					outputProducer(cargoMirOutput),
					(raw) => parseRustMirControlFlowGraphs(raw.text, raw.command.cwd),
				),
				controlFlowGraphOutput(
					'llvm-ir',
					'LLVM IR CFG',
					'Build a graph from rustc LLVM IR output.',
					outputProducer(cargoLlvmIrOutput),
					(raw) => parseLlvmControlFlowGraphs(raw.text, raw.command.cwd),
				),
				assemblyControlFlowGraphOutput,
			],
		},
		'optimization-pipeline': { producer: pipelineProducer(cargoPipelineArguments) },
		'machine-code-analysis': machineCodeAnalysis,
	},
};
