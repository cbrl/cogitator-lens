import type { CancellationToken, Uri } from 'vscode';
import path from 'path';
import type {
	ArtifactKind,
	CompileOptions,
	RawArtifact,
} from '../../types/index.js';
import type {
	CompilerOutputSpec,
	ToolchainBackend,
} from '../../toolchains/toolchain-backend.js';
import type { ArtifactProducer } from '../../toolchains/toolchain-map.js';

/**
 * Produces a control-flow graph from the assembly listing a toolchain already
 * knows how to emit.
 *
 * Toolchains without a documented IR dump reach the graph this way: the listing
 * is produced exactly as it is for the assembly artifact, and the renderer runs
 * it through the toolchain's assembly parser before building blocks.
 */
export const assemblyControlFlowGraphProducer: ArtifactProducer = async (
	backend: ToolchainBackend,
	source: Uri,
	options: CompileOptions,
	cancellationToken: CancellationToken,
): Promise<RawArtifact> => ({
	...(await backend.produceAssembly(source, options, cancellationToken)),
	kind: 'control-flow-graph',
});

export function compilerOutputProducer(
	kind: ArtifactKind,
	spec: CompilerOutputSpec,
): ArtifactProducer {
	return (
		backend: ToolchainBackend,
		source: Uri,
		options: CompileOptions,
		cancellationToken: CancellationToken,
	): Promise<RawArtifact> =>
		backend.produceCompilerOutput(kind, source, options, spec, cancellationToken);
}

export const llvmIrOutput: CompilerOutputSpec = Object.freeze({
	outputFilename: 'output.ll',
	arguments: (outputFile: string) => [
		'-emit-llvm',
		'-S',
		'-gline-tables-only',
		'-o',
		outputFile,
	],
});

export const clangClLlvmIrOutput: CompilerOutputSpec = Object.freeze({
	outputFilename: 'output.ll',
	arguments: (outputFile: string) => [
		'/clang:-emit-llvm',
		'/clang:-S',
		'/clang:-gline-tables-only',
		'/clang:-o',
		`/clang:${outputFile}`,
	],
});

export const gccControlFlowGraphOutput: CompilerOutputSpec = Object.freeze({
	outputFilename: 'output.cfg',
	arguments: (outputFile: string, temporaryDirectory: string) => [
		'-c',
		`-fdump-tree-cfg=${outputFile}`,
		'-o',
		path.join(temporaryDirectory, 'output.o'),
	],
});

export const rustMirOutput: CompilerOutputSpec = Object.freeze({
	outputFilename: 'output.mir',
	arguments: (outputFile: string, _temporaryDirectory: string, providerArguments: readonly string[]) =>
		rustArtifactArguments('mir', outputFile, providerArguments),
});

export const rustLlvmIrOutput: CompilerOutputSpec = Object.freeze({
	outputFilename: 'output.ll',
	arguments: (outputFile: string, _temporaryDirectory: string, providerArguments: readonly string[]) =>
		rustArtifactArguments('llvm-ir', outputFile, providerArguments),
});

export function rustArtifactArguments(
	emit: 'mir' | 'llvm-ir',
	outputFile: string,
	providerArguments: readonly string[],
): readonly string[] {
	return [
		...(hasOption(providerArguments, '--crate-name') ? [] : ['--crate-name=coglens_artifact']),
		...(hasOption(providerArguments, '--crate-type') ? [] : ['--crate-type=lib']),
		`--emit=${emit}=${outputFile}`,
		...(emit === 'llvm-ir' ? ['-C', 'debuginfo=1'] : []),
		'--error-format=human',
		'--color=never',
	];
}

function hasOption(args: readonly string[], name: string): boolean {
	return args.some(argument => argument === name || argument.startsWith(`${name}=`));
}
