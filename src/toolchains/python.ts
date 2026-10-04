import { sameLocalFile } from '../local-file-identity.js';
import { pythonBytecodeProducer } from '../artifacts/python/python-bytecode-producer.js';
import { renderPythonBytecode } from '../artifacts/python/python-bytecode-renderer.js';
import { pythonAstProducer } from '../artifacts/ast/python-ast-producer.js';
import { renderPythonAst } from '../artifacts/ast/ast-renderer.js';
import { pythonControlFlowGraphProducer } from '../artifacts/python/python-cfg-producer.js';
import {
	pythonStackAnalysisProducer,
	renderPythonStackAnalysis,
} from '../artifacts/stack-analysis/python-stack-analysis.js';
import { parsePythonControlFlowGraphs } from '../artifacts/control-flow-graph/parsers/python-cfg-parser.js';
import { controlFlowGraphOutput, type ToolchainDefinition } from './toolchain-contracts.js';
import { parsePythonDiagnostics } from './python/diagnostics.js';

/** Removes interpreter mode switches and the source path owned by Python artifact production. */
export function stripPythonManagedArguments(
	args: readonly string[],
	sourceFile: string,
	workingDirectory: string,
): string[] {
	const result: string[] = [];
	for (let index = 0; index < args.length; index++) {
		const argument = args[index];
		if (sameLocalFile(argument, sourceFile, workingDirectory) || argument === '--') {
			continue;
		}
		if (argument === '-m' || argument === '-c') {
			index++;
			continue;
		}
		if (/^-[mc].+/.test(argument)) {
			continue;
		}
		result.push(argument);
	}
	return result;
}

export const python: ToolchainDefinition = {
	executablePattern: /^(?:python(?:\d+(?:\.\d+)*)?|py)(?:\.exe)?$/i,
	parseDiagnostics: parsePythonDiagnostics,
	languageIdentifiers: Object.freeze(['python']),
	stripOwnedArguments: stripPythonManagedArguments,
	artifacts: {
		assembly: {
			producer: pythonBytecodeProducer,
			renderer: renderPythonBytecode,
			listingSyntax: 'python-bytecode',
		},
		ast: {
			producer: pythonAstProducer,
			renderer: renderPythonAst,
		},
		'stack-analysis': {
			producer: pythonStackAnalysisProducer,
			renderer: renderPythonStackAnalysis,
		},
		'control-flow-graph': {
			outputs: [
				controlFlowGraphOutput(
					'python-bytecode',
					'Python bytecode CFG',
					'Build a graph from recursively inspected Python bytecode.',
					pythonControlFlowGraphProducer,
					(raw) => parsePythonControlFlowGraphs(raw.text, raw.command.cwd),
				),
			],
		},
	},
};
