import path from 'node:path';
import type { CompilerOutputSpec } from '../../toolchains/toolchain-backend.js';
import { parseClangOptimizationRemarks } from './clang-optimization-remarks.js';
import { optimizationRemarksRenderer } from './optimization-remarks-renderer.js';

export const clangClOptimizationRemarksOutput: CompilerOutputSpec = Object.freeze({
	outputFilename: 'output.opt.yaml',
	optionalOutput: true,
	arguments: (outputFile: string, temporaryDirectory: string) => [
		'/c', '/clang:-fsave-optimization-record=yaml',
		`/clang:-foptimization-record-file=${outputFile}`,
		`/Fo${path.join(temporaryDirectory, 'output.obj')}`,
	],
});

export const renderClangClOptimizationRemarks = optimizationRemarksRenderer(parseClangOptimizationRemarks);
