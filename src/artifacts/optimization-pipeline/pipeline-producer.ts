import path from 'path';
import { CompilationError, type CompileOptions } from '../../types/index.js';
import type { ArtifactProducer } from '../../toolchains/toolchain-contracts.js';

/**
 * The arguments that make a compiler print the LLVM IR of one function before and after each pass.
 * The compile also writes its code to the temporary directory, so the machine passes run too.
 */
export type PipelineArguments = (
	functionFilter: string,
	temporaryDirectory: string,
	providerArguments: readonly string[],
) => readonly string[];

/** The function of a pipeline compile. Without a function, the compile does not start. */
export function requiredFunctionFilter(options: CompileOptions): string {
	if (options.functionFilter === undefined) {
		throw new CompilationError(
			'The optimization pipeline shows one function. Run "Open Artifact" again to select a function.',
		);
	}
	return options.functionFilter;
}

/**
 * Runs the compiler with the pass dumps of one function and reads them from the error output.
 * Without the filter, the dumps of each function can reach a size of gigabytes.
 */
export function pipelineProducer(dumpArguments: PipelineArguments): ArtifactProducer {
	return async (backend, source, options, cancellationToken) => {
		const functionFilter = requiredFunctionFilter(options);
		return backend.produceArtifact(
			source,
			options,
			{
				output: 'stderr',
				arguments: (_outputFile, temporaryDirectory, providerArguments) =>
					dumpArguments(functionFilter, temporaryDirectory, providerArguments),
			},
			cancellationToken,
		);
	};
}

/** The LLVM options of the pass dumps of one function. */
export function llvmPassDumpOptions(functionFilter: string): readonly string[] {
	return ['-print-before-all', '-print-after-all', `-filter-print-funcs=${functionFilter}`];
}

/**
 * The rustc options of the pass dumps of one function. rustc and Cargo use them. With more than one
 * codegen unit, the units run at the same time, and their pass dumps mix.
 */
export function rustPassDumpArguments(functionFilter: string): readonly string[] {
	return ['-C', 'codegen-units=1', '-C', `llvm-args=${llvmPassDumpOptions(functionFilter).join(' ')}`];
}

/** Clang writes assembly, so each pass of the code generator runs. */
export const clangPipelineArguments: PipelineArguments = (functionFilter, temporaryDirectory) => [
	'-S',
	'-o',
	path.join(temporaryDirectory, 'output.s'),
	...llvmPassDumpOptions(functionFilter).flatMap((option) => ['-mllvm', option]),
];

/** clang-cl writes an object file, so each pass of the code generator runs. */
export const clangClPipelineArguments: PipelineArguments = (functionFilter, temporaryDirectory) => [
	'/c',
	`/Fo${path.join(temporaryDirectory, 'output.obj')}`,
	...llvmPassDumpOptions(functionFilter).flatMap((option) => ['-mllvm', option]),
];
