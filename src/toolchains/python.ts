import { samePath } from '../toolchain-arguments.js';
import { pythonBytecodeProducer } from '../artifacts/python/python-bytecode-producer.js';
import { renderPythonBytecode } from '../artifacts/python/python-bytecode-renderer.js';
import { pythonAstProducer } from '../artifacts/ast/python-ast-producer.js';
import { renderPythonAst } from '../artifacts/ast/ast-renderer.js';
import { pythonControlFlowGraphProducer } from '../artifacts/python/python-cfg-producer.js';
import { pythonStackAnalysisProducer, renderPythonStackAnalysis } from '../artifacts/stack-analysis/python-stack-analysis.js';
import { parsePythonControlFlowGraphs } from '../artifacts/control-flow-graph/parsers/python-cfg-parser.js';
import { artifactCells, controlFlowGraphOutput, outputArtifactCell, toolDiscoverer, type ToolchainDefinition } from './toolchain-contracts.js';

/** Removes interpreter mode switches and the source path owned by Python artifact production. */
export function stripPythonManagedArguments(args: readonly string[], sourceFile: string, workingDirectory: string): string[] {
	const result: string[] = [];
	for (let index = 0; index < args.length; index++) {
		const argument = args[index];
		if (samePath(argument, sourceFile, workingDirectory) || argument === '--') {continue;}
		if (argument === '-m' || argument === '-c') { index++; continue; }
		if (/^-[mc].+/.test(argument)) {continue;}
		result.push(argument);
	}
	return result;
}

export const python: ToolchainDefinition = {
	executablePattern: /^(?:python(?:\d+(?:\.\d+)*)?|py)(?:\.exe)?$/i,
	languageIdentifiers: Object.freeze(['python']), stripOwnedArguments: stripPythonManagedArguments,
	discoverTools: toolDiscoverer({}),
	artifacts: artifactCells({
		assembly: { status: 'available', producer: pythonBytecodeProducer, renderer: renderPythonBytecode, listingSyntax: 'python-bytecode' },
		ast: { status: 'available', producer: pythonAstProducer, renderer: (raw, _options, context) => renderPythonAst(raw, context) },
		'stack-analysis': { status: 'available', producer: pythonStackAnalysisProducer, renderer: renderPythonStackAnalysis },
		'control-flow-graph': outputArtifactCell([
			controlFlowGraphOutput('python-bytecode', 'Python bytecode CFG', 'Build a graph from recursively inspected Python bytecode.', pythonControlFlowGraphProducer, (raw) => parsePythonControlFlowGraphs(raw.text, raw.command.workingDirectory)),
		]),
	}),
};
