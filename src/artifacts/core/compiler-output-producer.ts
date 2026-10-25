import path from 'path';
import type { ArtifactOutputSpec } from '../../toolchains/toolchain-backend.js';
import type { ArtifactProducer } from '../../toolchains/toolchain-contracts.js';

const producers = new WeakMap<ArtifactOutputSpec, ArtifactProducer>();

/**
 * Runs the compiler with the arguments of an output specification and reads that output. One
 * specification has one producer, so artifact kinds that read the same output share it.
 */
export function outputProducer(spec: ArtifactOutputSpec): ArtifactProducer {
	let producer = producers.get(spec);
	if (!producer) {
		producer = (backend, source, options, cancellationToken) =>
			backend.produceArtifact(source, options, spec, cancellationToken);
		producers.set(spec, producer);
	}
	return producer;
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
