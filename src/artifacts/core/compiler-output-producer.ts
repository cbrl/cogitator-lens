import type { CancellationToken, Uri } from 'vscode';
import path from 'path';
import type { ArtifactKind, CompileOptions, RawArtifact } from '../../types/index.js';
import type { ArtifactOutputSpec, ToolchainBackend } from '../../toolchains/toolchain-backend.js';
import type { ArtifactProducer } from '../../toolchains/toolchain-contracts.js';

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

export function artifactProducer(kind: ArtifactKind, spec: ArtifactOutputSpec): ArtifactProducer {
	return (
		backend: ToolchainBackend,
		source: Uri,
		options: CompileOptions,
		cancellationToken: CancellationToken,
	): Promise<RawArtifact> => backend.produceArtifact(kind, source, options, spec, cancellationToken);
}

export const llvmIrOutput: ArtifactOutputSpec = Object.freeze({
	output: { filename: 'output.ll' },
	arguments: (outputFile: string) => ['-emit-llvm', '-S', '-gline-tables-only', '-o', outputFile],
});

export const clangClLlvmIrOutput: ArtifactOutputSpec = Object.freeze({
	output: { filename: 'output.ll' },
	arguments: (outputFile: string) => [
		'/clang:-emit-llvm',
		'/clang:-S',
		'/clang:-gline-tables-only',
		'/clang:-o',
		`/clang:${outputFile}`,
	],
});

export const gccControlFlowGraphOutput: ArtifactOutputSpec = Object.freeze({
	output: { filename: 'output.cfg' },
	arguments: (outputFile: string, temporaryDirectory: string) => [
		'-c',
		`-fdump-tree-cfg=${outputFile}`,
		'-o',
		path.join(temporaryDirectory, 'output.o'),
	],
});
