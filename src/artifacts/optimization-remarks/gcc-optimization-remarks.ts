import path from 'node:path';
import type { CompilerOutputSpec } from '../../toolchains/toolchain-backend.js';
import { processRawGccOptRemarks } from '../../vendor/lib/optimization-remarks.js';
import { normalizeOptimizationRemark, optimizationRemarksRenderer } from './optimization-remarks-renderer.js';

export const gccOptimizationRemarksOutput: CompilerOutputSpec = Object.freeze({
	outputFilename: 'output.opt',
	optionalOutput: true,
	arguments: (outputFile: string, temporaryDirectory: string) => [
		'-c', `-fopt-info-all=${outputFile}`,
		'-o', path.join(temporaryDirectory, 'output.o'),
	],
});

export function parseGccOptimizationRemarks(text: string, workingDirectory: string) {
	return processRawGccOptRemarks(text).map(remark => normalizeOptimizationRemark(remark, workingDirectory));
}

export const renderGccOptimizationRemarks = optimizationRemarksRenderer(parseGccOptimizationRemarks);
