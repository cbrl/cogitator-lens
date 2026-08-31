import path from 'node:path';
import type { ArtifactOutputSpec } from '../../toolchains/toolchain-backend.js';
import { processRawLlvmOptRemarks } from '../../vendor/lib/optimization-remarks.js';
import { normalizeOptimizationRemark, optimizationRemarksRenderer } from './optimization-remarks-renderer.js';

export const clangOptimizationRemarksOutput: ArtifactOutputSpec = Object.freeze({
	output: { filename: 'output.opt.yaml', optional: true },
	arguments: (outputFile: string, temporaryDirectory: string) => [
		'-c',
		'-fsave-optimization-record=yaml',
		`-foptimization-record-file=${outputFile}`,
		'-o',
		path.join(temporaryDirectory, 'output.o'),
	],
});

export function parseClangOptimizationRemarks(text: string, workingDirectory: string) {
	return processRawLlvmOptRemarks(text).map((remark) => normalizeOptimizationRemark(remark, workingDirectory));
}

export const renderClangOptimizationRemarks = optimizationRemarksRenderer(parseClangOptimizationRemarks);
