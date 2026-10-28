import {
	llvmObjdump,
	normalizeLlvmObjdumpOutput,
	type BinaryDisassembler,
} from '../artifacts/binary-disassembly/binary-disassembly-producer.js';
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
	ownedBeforeEndOfOptions,
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
	objectCodeViewLines,
} from './msvc.js';
import { withCodeViewSourceLines } from './msvc/codeview-lines.js';
import { composeDiagnosticParsers } from '../diagnostics.js';
import { parseGnuDiagnostics } from './c-family/diagnostics.js';
import { parseParenthesizedDiagnostics } from './msvc/diagnostics.js';

const clangOptionsWithValues = new Set(['/clang:-o', '/clang:-foptimization-record-file']);
const clangOptionArtifactFlags =
	/^\/clang:-(?:emit-llvm|S|gline-tables-only|save-temps(?:=.*)?|f(?:no-)?stack-usage|fsave-optimization-record(?:=.*)?|foptimization-record-file(?:=.*)?)$/;

/** Clang's colour switches, which clang-cl accepts directly and in their /clang: form. */
const clangClColorFlags = /^(?:\/clang:)?-f(?:no-)?(?:diagnostics-color(?:=.*)?|color-diagnostics|ansi-escape-codes)$/;

/**
 * The output and mode switches that clang-cl takes from the Clang driver: `-o` and `/o` with a
 * separate or joined name, and `-fsyntax-only`. The joined form leaves out `/openmp` and
 * `/options`, which also begin with an o.
 */
const clangClOutputFlags = new Set(['-o', '/o']);
const clangClOutputAssignments = /^[-/]o(?!penmp|ptions).+$/;
const clangClModeFlags = new Set(['-fsyntax-only']);

/** cl.exe's switches, the Clang driver's output switches, the /clang: forms that artifacts use, and the AST dump. */
const clangClOwnedArguments: OwnedArguments = {
	withValue: [...msvcOwnedArguments.withValue, clangClOutputFlags, clangOptionsWithValues, clangAstDumpPair],
	standalone: [
		...msvcOwnedArguments.standalone,
		clangClOutputAssignments,
		clangClModeFlags,
		clangOptionArtifactFlags,
		clangClColorFlags,
	],
};

/** llvm-objdump reads only DWARF line tables, so the lines come from the CodeView line table of the object. */
export const clangClObjdump: BinaryDisassembler = Object.freeze({
	tool: llvmObjdump.tool,
	arguments: llvmObjdump.arguments,
	normalizeOutput: async (output: string, objectFile: string) =>
		withCodeViewSourceLines(normalizeLlvmObjdumpOutput(output), await objectCodeViewLines(objectFile)),
});

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
	assembleArguments: ownedBeforeEndOfOptions,
	stripOwnedArguments: stripClangClManagedArguments,
	dependencyCollection: msvcDependencyCollection,
	createParser: defaultAsmParser,
	createCfgParser: () => new ClangAssemblyCfgParser(new InstructionSetInfo()),
	prepareEnvironment: captureWindowsEnvironment,
	discoverTools: toolDiscoverer({ demangler: 'llvm-cxxfilt', disassembler: 'llvm-objdump' }),
	artifacts: {
		assembly: compilerAssembly,
		'binary-disassembly': binaryDisassembly('llvm-objdump', clangClObjdump),
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
