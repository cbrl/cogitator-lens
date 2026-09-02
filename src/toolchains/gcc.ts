import { binaryDisassemblyProducer, gnuObjdump } from '../artifacts/binary-disassembly/binary-disassembly-producer.js';
import { artifactProducer, gccControlFlowGraphOutput } from '../artifacts/core/compiler-output-producer.js';
import { nativeStackAnalysisProducer } from '../artifacts/stack-analysis/native-stack-analysis.js';
import {
	gccOptimizationRemarksOutput,
	renderGccOptimizationRemarks,
} from '../artifacts/optimization-remarks/gcc-optimization-remarks.js';
import { parseGccControlFlowGraphs } from '../artifacts/control-flow-graph/parsers/gcc-cfg-parser.js';
import { GccAssemblyCfgParser } from '../artifacts/control-flow-graph/parsers/assembly-dialects.js';
import { InstructionSetInfo } from '../artifacts/control-flow-graph/parsers/instruction-sets.js';
import {
	artifactCells,
	assemblyCell,
	assemblyControlFlowGraphOutput,
	binaryCell,
	controlFlowGraphOutput,
	outputArtifactCell,
	toolDiscoverer,
	type ToolchainDefinition,
} from './toolchain-contracts.js';
import {
	cFamilyLanguageIdentifiers,
	defaultAsmParser,
	gnuDependencyCollection,
	gnuIntelArguments,
	gnuOutputArguments,
	gnuPreprocessedSourceProducer,
	stripCompilerManagedArguments,
} from './c-family.js';
import { parseGnuDiagnostics } from './c-family/diagnostics.js';

export const gcc: ToolchainDefinition = {
	executablePattern: /^(?:gcc|g\+\+)(?:-\d+(?:\.\d+)*)?(?:\.exe)?$/i,
	parseDiagnostics: parseGnuDiagnostics,
	languageIdentifiers: cFamilyLanguageIdentifiers,
	intelSyntax: 'selectable',
	intelArguments: gnuIntelArguments,
	includeFlag: '-I',
	defineFlag: '-D',
	objectFilename: 'output.o',
	outputArguments: gnuOutputArguments(['-g1']),
	stripOwnedArguments: stripCompilerManagedArguments,
	dependencyCollection: gnuDependencyCollection,
	createParser: defaultAsmParser,
	createCfgParser: () => new GccAssemblyCfgParser(new InstructionSetInfo()),
	discoverTools: toolDiscoverer({ demangler: 'c++filt', disassembler: 'objdump' }),
	artifacts: artifactCells({
		assembly: assemblyCell,
		'binary-disassembly': binaryCell('GNU objdump', binaryDisassemblyProducer(gnuObjdump)),
		'preprocessed-source': { status: 'available', producer: gnuPreprocessedSourceProducer },
		'optimization-remarks': {
			status: 'available',
			producer: artifactProducer('optimization-remarks', gccOptimizationRemarksOutput),
			renderer: renderGccOptimizationRemarks,
		},
		'stack-analysis': { status: 'available', producer: nativeStackAnalysisProducer },
		'control-flow-graph': outputArtifactCell([
			controlFlowGraphOutput(
				'gcc-tree',
				'GCC tree CFG',
				"Build a source-level graph from GCC's tree CFG dump.",
				artifactProducer('control-flow-graph', gccControlFlowGraphOutput),
				(raw) => parseGccControlFlowGraphs(raw.text, raw.command.workingDirectory),
			),
			assemblyControlFlowGraphOutput,
		]),
	}),
};
