import { llvmObjdump } from '../artifacts/binary-disassembly/binary-disassembly-producer.js';
import { outputProducer, clangClLlvmIrOutput } from '../artifacts/core/compiler-output-producer.js';
import { renderClangAst } from '../artifacts/ast/ast-renderer.js';
import {
	clangClOptimizationRemarksOutput,
	renderClangClOptimizationRemarks,
} from '../artifacts/optimization-remarks/clang-cl-optimization-remarks.js';
import { clangClStackAnalysisProducer } from '../artifacts/stack-analysis/native-stack-analysis.js';
import { parseLlvmControlFlowGraphs } from '../artifacts/control-flow-graph/parsers/llvm-ir-cfg-parser.js';
import { ClangAssemblyCfgParser } from '../artifacts/control-flow-graph/parsers/assembly-dialects.js';
import { InstructionSetInfo } from '../artifacts/control-flow-graph/parsers/instruction-sets.js';
import {
	compilerAssembly,
	assemblyControlFlowGraphOutput,
	binaryDisassembly,
	controlFlowGraphOutput,
	toolDiscoverer,
	withoutOwnedArguments,
	type OwnedArguments,
	type ToolchainDefinition,
} from './toolchain-contracts.js';
import { cFamilyLanguageIdentifiers, clangAstDumpPair, clangAstProducer, defaultAsmParser } from './c-family.js';
import {
	captureWindowsEnvironment,
	clangClOutputArguments,
	msvcDependencyCollection,
	msvcOwnedArguments,
	msvcPreprocessedSourceProducer,
} from './msvc.js';
import { composeDiagnosticParsers } from '../diagnostics.js';
import { parseGnuDiagnostics } from './c-family/diagnostics.js';
import { parseParenthesizedDiagnostics } from './msvc/diagnostics.js';

const clangOptionsWithValues = new Set(['/clang:-o', '/clang:-foptimization-record-file']);
const clangOptionArtifactFlags =
	/^\/clang:-(?:emit-llvm|S|gline-tables-only|save-temps(?:=.*)?|f(?:no-)?stack-usage|fsave-optimization-record(?:=.*)?|foptimization-record-file(?:=.*)?)$/;

/** Clang's colour switches, which clang-cl accepts directly and in their /clang: form. */
const clangClColorFlags = /^(?:\/clang:)?-f(?:no-)?(?:diagnostics-color(?:=.*)?|color-diagnostics|ansi-escape-codes)$/;

/** cl.exe's switches, the /clang: forms of the GNU switches that clang-cl artifacts use, and the AST dump. */
const clangClOwnedArguments: OwnedArguments = {
	withValue: [...msvcOwnedArguments.withValue, clangOptionsWithValues, clangAstDumpPair],
	standalone: [...msvcOwnedArguments.standalone, clangOptionArtifactFlags, clangClColorFlags],
};

export function stripClangClManagedArguments(
	args: readonly string[],
	sourceFile: string,
	workingDirectory?: string,
): string[] {
	return withoutOwnedArguments(args, sourceFile, workingDirectory, clangClOwnedArguments);
}

export const clangCl: ToolchainDefinition = {
	executablePattern: /^clang-cl(?:\.exe)?$/i,
	parseDiagnostics: composeDiagnosticParsers(parseGnuDiagnostics, parseParenthesizedDiagnostics),
	languageIdentifiers: cFamilyLanguageIdentifiers,
	intelSyntax: 'inherent',
	includeFlag: '/I',
	defineFlag: '/D',
	objectFilename: 'output.obj',
	outputArguments: clangClOutputArguments,
	stripOwnedArguments: stripClangClManagedArguments,
	dependencyCollection: msvcDependencyCollection,
	createParser: defaultAsmParser,
	createCfgParser: () => new ClangAssemblyCfgParser(new InstructionSetInfo()),
	prepareEnvironment: captureWindowsEnvironment,
	discoverTools: toolDiscoverer({ demangler: 'llvm-cxxfilt', disassembler: 'llvm-objdump' }),
	artifacts: {
		assembly: compilerAssembly,
		'binary-disassembly': binaryDisassembly('llvm-objdump', llvmObjdump),
		'preprocessed-source': { producer: msvcPreprocessedSourceProducer },
		ast: { producer: clangAstProducer, renderer: renderClangAst },
		'llvm-ir': { producer: outputProducer(clangClLlvmIrOutput) },
		'optimization-remarks': {
			producer: outputProducer(clangClOptimizationRemarksOutput),
			renderer: renderClangClOptimizationRemarks,
		},
		'stack-analysis': { producer: clangClStackAnalysisProducer },
		'control-flow-graph': {
			outputs: [
				controlFlowGraphOutput(
					'llvm-ir',
					'LLVM IR CFG',
					'Build a graph from the compiler LLVM IR output.',
					outputProducer(clangClLlvmIrOutput),
					(raw) => parseLlvmControlFlowGraphs(raw.text, raw.command.cwd),
				),
				assemblyControlFlowGraphOutput,
			],
		},
	},
};
