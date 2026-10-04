import path from 'path';
import type { ArtifactOutputSpec } from '../../toolchains/toolchain-backend.js';
import type { ArtifactProducer } from '../../toolchains/toolchain-contracts.js';

/** Runs the compiler with the arguments of an output specification and reads that output. */
export function outputProducer(spec: ArtifactOutputSpec): ArtifactProducer {
	return (backend, source, options, cancellationToken) =>
		backend.produceArtifact(source, options, spec, cancellationToken);
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
