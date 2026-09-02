import { binaryDisassemblyProducer, llvmObjdump } from '../artifacts/binary-disassembly/binary-disassembly-producer.js';
import { artifactProducer, clangClLlvmIrOutput } from '../artifacts/core/compiler-output-producer.js';
import { renderClangAst } from '../artifacts/ast/ast-renderer.js';
import { clangClOptimizationRemarksOutput, renderClangClOptimizationRemarks } from '../artifacts/optimization-remarks/clang-cl-optimization-remarks.js';
import { clangClStackAnalysisProducer } from '../artifacts/stack-analysis/native-stack-analysis.js';
import { parseLlvmControlFlowGraphs } from '../artifacts/control-flow-graph/parsers/llvm-ir-cfg-parser.js';
import { ClangAssemblyCfgParser } from '../artifacts/control-flow-graph/parsers/assembly-dialects.js';
import { InstructionSetInfo } from '../artifacts/control-flow-graph/parsers/instruction-sets.js';
import {
	artifactCells, assemblyCell, assemblyControlFlowGraphOutput, binaryCell, controlFlowGraphOutput,
	outputArtifactCell, toolDiscoverer, type ToolchainDefinition,
} from './toolchain-contracts.js';
import { cFamilyLanguageIdentifiers, clangAstProducer, defaultAsmParser, stripCompilerManagedArguments } from './c-family.js';
import {
	captureWindowsEnvironment, clangClOutputArguments, msvcDependencyCollection,
	msvcPreprocessedSourceProducer, windowsDemangle,
} from './msvc.js';
import { composeDiagnosticParsers } from '../diagnostics.js';
import { parseGnuDiagnostics } from './c-family/diagnostics.js';
import { parseParenthesizedDiagnostics } from './msvc/diagnostics.js';

export const clangCl: ToolchainDefinition = {
	executablePattern: /^clang-cl(?:\.exe)?$/i,
	parseDiagnostics: composeDiagnosticParsers(parseGnuDiagnostics, parseParenthesizedDiagnostics),
	languageIdentifiers: cFamilyLanguageIdentifiers,
	intelSyntax: 'inherent', includeFlag: '/I', defineFlag: '/D', objectFilename: 'output.obj',
	outputArguments: clangClOutputArguments,
	stripOwnedArguments: stripCompilerManagedArguments,
	dependencyCollection: msvcDependencyCollection,
	createParser: defaultAsmParser,
	createCfgParser: () => new ClangAssemblyCfgParser(new InstructionSetInfo()),
	prepareEnvironment: captureWindowsEnvironment, demangle: windowsDemangle,
	discoverTools: toolDiscoverer({ demangler: 'llvm-cxxfilt', disassembler: 'llvm-objdump' }),
	artifacts: artifactCells({
		assembly: assemblyCell,
		'binary-disassembly': binaryCell('llvm-objdump', binaryDisassemblyProducer(llvmObjdump)),
		'preprocessed-source': { status: 'available', producer: msvcPreprocessedSourceProducer },
		ast: { status: 'available', producer: clangAstProducer, renderer: renderClangAst },
		'llvm-ir': { status: 'available', producer: artifactProducer('llvm-ir', clangClLlvmIrOutput) },
		'optimization-remarks': {
			status: 'available', producer: artifactProducer('optimization-remarks', clangClOptimizationRemarksOutput),
			renderer: renderClangClOptimizationRemarks,
		},
		'stack-analysis': { status: 'available', producer: clangClStackAnalysisProducer },
		'control-flow-graph': outputArtifactCell([
			controlFlowGraphOutput('llvm-ir', 'LLVM IR CFG', 'Build a graph from the compiler LLVM IR output.',
				artifactProducer('control-flow-graph', clangClLlvmIrOutput),
				(raw) => parseLlvmControlFlowGraphs(raw.text, raw.command.workingDirectory)),
			assemblyControlFlowGraphOutput,
		]),
	}),
};
