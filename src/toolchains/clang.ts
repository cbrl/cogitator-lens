import { llvmObjdump } from '../artifacts/binary-disassembly/binary-disassembly-producer.js';
import { outputProducer, llvmIrOutput } from '../artifacts/core/compiler-output-producer.js';
import { renderClangAst } from '../artifacts/ast/ast-renderer.js';
import {
	clangOptimizationRemarksOutput,
	renderClangOptimizationRemarks,
} from '../artifacts/optimization-remarks/clang-optimization-remarks.js';
import { nativeStackAnalysisProducer } from '../artifacts/stack-analysis/native-stack-analysis.js';
import { parseLlvmControlFlowGraphs } from '../artifacts/control-flow-graph/parsers/llvm-ir-cfg-parser.js';
import { ClangAssemblyCfgParser } from '../artifacts/control-flow-graph/parsers/assembly-dialects.js';
import { InstructionSetInfo } from '../artifacts/control-flow-graph/parsers/instruction-sets.js';
import {
	compilerAssembly,
	assemblyControlFlowGraphOutput,
	binaryDisassembly,
	controlFlowGraphOutput,
	toolDiscoverer,
	type ToolchainDefinition,
} from './toolchain-contracts.js';
import {
	cFamilyLanguageIdentifiers,
	clangAstProducer,
	defaultAsmParser,
	gnuDependencyCollection,
	gnuIntelArguments,
	gnuOutputArguments,
	gnuPreprocessedSourceProducer,
	stripCompilerManagedArguments,
} from './c-family.js';
import { parseGnuDiagnostics } from './c-family/diagnostics.js';

const artifacts: ToolchainDefinition['artifacts'] = {
	assembly: compilerAssembly,
	'binary-disassembly': binaryDisassembly('llvm-objdump', llvmObjdump),
	'preprocessed-source': { producer: gnuPreprocessedSourceProducer },
	ast: { producer: clangAstProducer, renderer: renderClangAst },
	'llvm-ir': { producer: outputProducer(llvmIrOutput) },
	'optimization-remarks': {
		producer: outputProducer(clangOptimizationRemarksOutput),
		renderer: renderClangOptimizationRemarks,
	},
	'stack-analysis': { producer: nativeStackAnalysisProducer },
	'control-flow-graph': {
		outputs: [
			controlFlowGraphOutput(
				'llvm-ir',
				'LLVM IR CFG',
				'Build a graph from the compiler LLVM IR output.',
				outputProducer(llvmIrOutput),
				(raw) => parseLlvmControlFlowGraphs(raw.text, raw.command.cwd),
			),
			assemblyControlFlowGraphOutput,
		],
	},
};

export const clang: ToolchainDefinition = {
	executablePattern: /^clang(?:\+\+)?(?:-\d+(?:\.\d+)*)?(?:\.exe)?$/i,
	parseDiagnostics: parseGnuDiagnostics,
	languageIdentifiers: cFamilyLanguageIdentifiers,
	intelSyntax: 'selectable',
	intelArguments: gnuIntelArguments,
	includeFlag: '-I',
	defineFlag: '-D',
	objectFilename: 'output.o',
	outputArguments: gnuOutputArguments(['-gline-tables-only']),
	stripOwnedArguments: stripCompilerManagedArguments,
	dependencyCollection: gnuDependencyCollection,
	createParser: defaultAsmParser,
	createCfgParser: () => new ClangAssemblyCfgParser(new InstructionSetInfo()),
	discoverTools: toolDiscoverer({ demangler: 'llvm-cxxfilt', disassembler: 'llvm-objdump' }),
	artifacts,
};

export const appleClang: ToolchainDefinition = {
	...clang,
	disambiguate: (versionOutput, platform) => /apple clang/i.test(versionOutput) || platform === 'darwin',
};
