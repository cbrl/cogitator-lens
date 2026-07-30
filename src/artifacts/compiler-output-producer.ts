import type { CancellationToken, Uri } from 'vscode';
import path from 'path';
import type {
	ArtifactKind,
	CompileOptions,
	RawArtifact,
} from '../types/index.js';
import type {
	CompilerOutputSpec,
	ToolchainBackend,
} from '../toolchains/toolchain-backend.js';
import type { ArtifactProducer } from '../toolchains/toolchain-map.js';

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

export const clangOptimizationRecord: CompilerOutputSpec = Object.freeze({
	outputFilename: 'output.opt.yaml',
	optionalOutput: true,
	arguments: (outputFile: string, temporaryDirectory: string) => [
		'-c',
		'-fsave-optimization-record=yaml',
		`-foptimization-record-file=${outputFile}`,
		'-o',
		path.join(temporaryDirectory, 'output.o'),
	],
});

export const clangClOptimizationRecord: CompilerOutputSpec = Object.freeze({
	outputFilename: 'output.opt.yaml',
	optionalOutput: true,
	arguments: (outputFile: string, temporaryDirectory: string) => [
		'/c',
		'/clang:-fsave-optimization-record=yaml',
		`/clang:-foptimization-record-file=${outputFile}`,
		`/Fo${path.join(temporaryDirectory, 'output.obj')}`,
	],
});

export const gccOptimizationRecord: CompilerOutputSpec = Object.freeze({
	outputFilename: 'output.opt',
	optionalOutput: true,
	arguments: (outputFile: string, temporaryDirectory: string) => [
		'-c',
		`-fopt-info-all=${outputFile}`,
		'-o',
		path.join(temporaryDirectory, 'output.o'),
	],
});
