import path from 'path';
import type {
	ArtifactKind,
	ArtifactOptionAvailability,
	ArtifactOptionId,
	ToolchainKind,
	ToolchainProfile,
} from '../types/index.js';
import type { DependencyCollectionSpec } from '../toolchains/toolchain-backend.js';
import { AsmParser } from '../vendor/lib/parsers/asm-parser.js';
import { noopPropertyGetter } from '../vendor/compiler-props.js';
import {
	captureWindowsEnvironment,
	clangClOutputArguments,
	createMsvcAsmParser,
	msvcOutputArguments,
	windowsDemangle,
} from './msvc.js';
import { rustOutputArguments, stripRustManagedArguments } from './rust.js';
import { stripPythonManagedArguments } from './python.js';
import { goAssemblyProducer, goSsaControlFlowGraphProducer, stripGoManagedArguments } from './go.js';
import { zigLlvmIrOutput, zigOutputArguments, stripZigManagedArguments } from './zig.js';
import { nvccOutputArguments, nvdisasm, stripNvccManagedArguments } from './nvcc.js';
import { artifactDefinitions } from '../artifacts/core/artifact-definitions.js';
import {
	binaryDisassemblyProducer,
	dumpbin,
	gnuObjdump,
	llvmObjdump,
} from '../artifacts/binary-disassembly/binary-disassembly-producer.js';
import {
	clangClLlvmIrOutput,
	artifactProducer,
	gccControlFlowGraphOutput,
	llvmIrOutput,
	rustLlvmIrOutput,
	rustMirOutput,
} from '../artifacts/core/compiler-output-producer.js';
import { pythonBytecodeProducer } from '../artifacts/python/python-bytecode-producer.js';
import { renderPythonBytecode } from '../artifacts/python/python-bytecode-renderer.js';
import { pythonControlFlowGraphProducer } from '../artifacts/python/python-cfg-producer.js';
import { pythonAstProducer } from '../artifacts/ast/python-ast-producer.js';
import { renderClangAst, renderPythonAst } from '../artifacts/ast/ast-renderer.js';
import {
	clangOptimizationRemarksOutput,
	renderClangOptimizationRemarks,
} from '../artifacts/optimization-remarks/clang-optimization-remarks.js';
import {
	clangClOptimizationRemarksOutput,
	renderClangClOptimizationRemarks,
} from '../artifacts/optimization-remarks/clang-cl-optimization-remarks.js';
import {
	gccOptimizationRemarksOutput,
	renderGccOptimizationRemarks,
} from '../artifacts/optimization-remarks/gcc-optimization-remarks.js';
import { parseMakeDepfile, parseMsvcSourceDependencies } from '../compilation/artifact-inputs.js';
import {
	clangClStackAnalysisProducer,
	nativeStackAnalysisProducer,
} from '../artifacts/stack-analysis/native-stack-analysis.js';
import {
	pythonStackAnalysisProducer,
	renderPythonStackAnalysis,
} from '../artifacts/stack-analysis/python-stack-analysis.js';
import {
	ClangAssemblyCfgParser,
	GccAssemblyCfgParser,
	MsvcAssemblyCfgParser,
} from '../artifacts/control-flow-graph/parsers/assembly-dialects.js';
import { InstructionSetInfo } from '../artifacts/control-flow-graph/parsers/instruction-sets.js';
import { parseGccControlFlowGraphs } from '../artifacts/control-flow-graph/parsers/gcc-cfg-parser.js';
import { parseLlvmControlFlowGraphs } from '../artifacts/control-flow-graph/parsers/llvm-ir-cfg-parser.js';
import { parsePythonControlFlowGraphs } from '../artifacts/control-flow-graph/parsers/python-cfg-parser.js';
import { parseRustMirControlFlowGraphs } from '../artifacts/control-flow-graph/parsers/rust-mir-cfg-parser.js';
import { parseGoSsaControlFlowGraphs } from '../artifacts/control-flow-graph/parsers/go-ssa-cfg-parser.js';
import { GoAsmParser } from '../vendor/lib/parsers/asm-parser-go.js';
import { PTXAsmParser } from '../vendor/lib/parsers/asm-parser-ptx.js';
import { SassAsmParser } from '../vendor/lib/parsers/asm-parser-sass.js';
import { discoverDotNetTools, dotNetIlProducer, stripDotNetManagedArguments } from './dotnet.js';
import { renderDotNetIl } from '../artifacts/dotnet/dotnet-il-renderer.js';
import {
	artifactCells,
	assemblyCell,
	assemblyControlFlowGraphOutput,
	binaryCell,
	controlFlowGraphOutput,
	outputArtifactCell,
	toolDiscoverer,
	type ToolchainArtifactCell,
	type ToolchainArtifactOutput,
	type ToolchainDefinition,
	type ToolchainDefinitionShape,
	type ResolvedToolchainArtifactCell,
} from './toolchain-contracts.js';

export type {
	ArtifactProducer,
	ResolvedToolchainArtifactCell,
	ToolchainArtifactCell,
	ToolchainArtifactImplementation,
	ToolchainArtifactOutput,
	ToolchainDefinition,
	ToolchainDefinitionShape,
} from './toolchain-contracts.js';

export type ToolCapabilityStatus = 'available' | 'unavailable' | 'unsupported';

const cFamilyLanguageIdentifiers = Object.freeze(['c', 'cpp', 'objective-c', 'objective-cpp', 'cuda']);

function gnuOutputArguments(lineTableArguments: readonly string[]) {
	return (target: 'assembly' | 'object', outputFile: string): readonly string[] =>
		target === 'assembly'
			? ['-S', ...lineTableArguments, '-o', outputFile]
			: ['-c', ...lineTableArguments, '-o', outputFile];
}

const gnuDependencyCollection: DependencyCollectionSpec = Object.freeze({
	outputFilename: 'dependencies.d',
	arguments: (outputFile: string) => ['-M', '-MF', outputFile],
	parse: parseMakeDepfile,
});

const msvcDependencyCollection: DependencyCollectionSpec = Object.freeze({
	outputFilename: 'dependencies.json',
	arguments: (outputFile: string, temporaryDirectory: string) => [
		'/c',
		'/sourceDependencies',
		outputFile,
		`/Fo${path.join(temporaryDirectory, 'dependencies.obj')}`,
	],
	parse: parseMsvcSourceDependencies,
});

const rustDependencyCollection: DependencyCollectionSpec = Object.freeze({
	outputFilename: 'dependencies.d',
	arguments: (outputFile: string, _temporaryDirectory: string, providerArguments: readonly string[]) => [
		...(hasOption(providerArguments, '--crate-name') ? [] : ['--crate-name=coglens_artifact']),
		...(hasOption(providerArguments, '--crate-type') ? [] : ['--crate-type=lib']),
		`--emit=dep-info=${outputFile}`,
		'--error-format=human',
		'--color=never',
	],
	parse: parseMakeDepfile,
});

const gnuPreprocessedSourceProducer = artifactProducer('preprocessed-source', {
	output: 'stdout',
	arguments: () => ['-E'],
});
const msvcPreprocessedSourceProducer = artifactProducer('preprocessed-source', {
	output: 'stdout',
	arguments: () => ['/E'],
});
const clangAstProducer = artifactProducer('ast', {
	output: 'stdout',
	arguments: () => ['-Xclang', '-ast-dump', '-fsyntax-only'],
	acceptOutputOnError: true,
});

const gnuIntelArguments = Object.freeze(['-masm=intel']);
const rustIntelArguments = Object.freeze(['-C', 'llvm-args=-x86-asm-syntax=intel']);

const defaultAsmParser = (): AsmParser => new AsmParser(noopPropertyGetter);

function hasOption(args: readonly string[], name: string): boolean {
	return args.some((argument) => argument === name || argument.startsWith(`${name}=`));
}

const clangArtifacts = artifactCells({
	assembly: assemblyCell,
	'binary-disassembly': binaryCell('llvm-objdump', binaryDisassemblyProducer(llvmObjdump)),
	'preprocessed-source': {
		status: 'available',
		producer: gnuPreprocessedSourceProducer,
	},
	ast: {
		status: 'available',
		producer: clangAstProducer,
		renderer: renderClangAst,
	},
	'llvm-ir': {
		status: 'available',
		producer: artifactProducer('llvm-ir', llvmIrOutput),
	},
	'optimization-remarks': {
		status: 'available',
		producer: artifactProducer('optimization-remarks', clangOptimizationRemarksOutput),
		renderer: renderClangOptimizationRemarks,
	},
	'stack-analysis': {
		status: 'available',
		producer: nativeStackAnalysisProducer,
	},
	'control-flow-graph': outputArtifactCell([
		controlFlowGraphOutput(
			'llvm-ir',
			'LLVM IR CFG',
			'Build a graph from the compiler LLVM IR output.',
			artifactProducer('control-flow-graph', llvmIrOutput),
			(raw) => parseLlvmControlFlowGraphs(raw.text, raw.command.workingDirectory),
		),
		assemblyControlFlowGraphOutput,
	]),
});

const gccArtifacts = artifactCells({
	assembly: assemblyCell,
	'binary-disassembly': binaryCell('GNU objdump', binaryDisassemblyProducer(gnuObjdump)),
	'preprocessed-source': {
		status: 'available',
		producer: gnuPreprocessedSourceProducer,
	},
	'optimization-remarks': {
		status: 'available',
		producer: artifactProducer('optimization-remarks', gccOptimizationRemarksOutput),
		renderer: renderGccOptimizationRemarks,
	},
	'stack-analysis': {
		status: 'available',
		producer: nativeStackAnalysisProducer,
	},
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
});

const msvcArtifacts = artifactCells({
	assembly: assemblyCell,
	'binary-disassembly': binaryCell('dumpbin', binaryDisassemblyProducer(dumpbin)),
	'preprocessed-source': {
		status: 'available',
		producer: msvcPreprocessedSourceProducer,
	},
	'control-flow-graph': outputArtifactCell([assemblyControlFlowGraphOutput]),
});

const clangClArtifacts = artifactCells({
	assembly: assemblyCell,
	'binary-disassembly': binaryCell('llvm-objdump', binaryDisassemblyProducer(llvmObjdump)),
	'preprocessed-source': {
		status: 'available',
		producer: msvcPreprocessedSourceProducer,
	},
	ast: {
		status: 'available',
		producer: clangAstProducer,
		renderer: renderClangAst,
	},
	'llvm-ir': {
		status: 'available',
		producer: artifactProducer('llvm-ir', clangClLlvmIrOutput),
	},
	'optimization-remarks': {
		status: 'available',
		producer: artifactProducer('optimization-remarks', clangClOptimizationRemarksOutput),
		renderer: renderClangClOptimizationRemarks,
	},
	'stack-analysis': {
		status: 'available',
		producer: clangClStackAnalysisProducer,
	},
	'control-flow-graph': outputArtifactCell([
		controlFlowGraphOutput(
			'llvm-ir',
			'LLVM IR CFG',
			'Build a graph from the compiler LLVM IR output.',
			artifactProducer('control-flow-graph', clangClLlvmIrOutput),
			(raw) => parseLlvmControlFlowGraphs(raw.text, raw.command.workingDirectory),
		),
		assemblyControlFlowGraphOutput,
	]),
});

const rustArtifacts = artifactCells({
	assembly: assemblyCell,
	'llvm-ir': {
		status: 'available',
		producer: artifactProducer('llvm-ir', rustLlvmIrOutput),
	},
	'rust-mir': {
		status: 'available',
		producer: artifactProducer('rust-mir', rustMirOutput),
	},
	'control-flow-graph': outputArtifactCell([
		controlFlowGraphOutput(
			'rust-mir',
			'Rust MIR CFG',
			'Build a source-level graph from rustc MIR output.',
			artifactProducer('control-flow-graph', rustMirOutput),
			(raw) => parseRustMirControlFlowGraphs(raw.text, raw.command.workingDirectory),
		),
		controlFlowGraphOutput(
			'llvm-ir',
			'LLVM IR CFG',
			'Build a graph from rustc LLVM IR output.',
			artifactProducer('control-flow-graph', rustLlvmIrOutput),
			(raw) => parseLlvmControlFlowGraphs(raw.text, raw.command.workingDirectory),
		),
		assemblyControlFlowGraphOutput,
	]),
});

const pythonArtifacts = artifactCells({
	assembly: {
		status: 'available',
		producer: pythonBytecodeProducer,
		renderer: renderPythonBytecode,
		listingSyntax: 'python-bytecode',
	},
	ast: {
		status: 'available',
		producer: pythonAstProducer,
		renderer: (raw, _options, context) => renderPythonAst(raw, context),
	},
	'stack-analysis': {
		status: 'available',
		producer: pythonStackAnalysisProducer,
		renderer: renderPythonStackAnalysis,
	},
	'control-flow-graph': outputArtifactCell([
		controlFlowGraphOutput(
			'python-bytecode',
			'Python bytecode CFG',
			'Build a graph from recursively inspected Python bytecode.',
			pythonControlFlowGraphProducer,
			(raw) => parsePythonControlFlowGraphs(raw.text, raw.command.workingDirectory),
		),
	]),
});

const goArtifacts = artifactCells({
	assembly: {
		status: 'available',
		producer: goAssemblyProducer,
	},
	'control-flow-graph': outputArtifactCell([
		controlFlowGraphOutput(
			'go-ssa',
			'Go SSA CFG',
			'Build a source-level graph from the final GOSSAFUNC SSA snapshot.',
			goSsaControlFlowGraphProducer,
			(raw, _options, context) => parseGoSsaControlFlowGraphs(raw.text, context.source.uri.toString()),
		),
	]),
});

const zigArtifacts = artifactCells({
	assembly: assemblyCell,
	'llvm-ir': {
		status: 'available',
		producer: artifactProducer('llvm-ir', zigLlvmIrOutput),
	},
	'control-flow-graph': outputArtifactCell([
		controlFlowGraphOutput(
			'llvm-ir',
			'LLVM IR CFG',
			'Build a graph from Zig LLVM IR output.',
			artifactProducer('control-flow-graph', zigLlvmIrOutput),
			(raw) => parseLlvmControlFlowGraphs(raw.text, raw.command.workingDirectory),
		),
		assemblyControlFlowGraphOutput,
	]),
});

const nvccArtifacts = artifactCells({
	assembly: assemblyCell,
	'binary-disassembly': binaryCell('nvdisasm', binaryDisassemblyProducer(nvdisasm)),
	'preprocessed-source': {
		status: 'available',
		producer: gnuPreprocessedSourceProducer,
	},
});

const dotNetArtifacts = artifactCells({
	assembly: {
		status: 'available',
		producer: dotNetIlProducer,
		renderer: renderDotNetIl,
		listingSyntax: 'dotnet-il',
		requiredTools: [
			{ name: 'compiler', label: 'Roslyn csc.dll' },
			{ name: 'ildasm', label: '.NET IL disassembler (ildasm)' },
		],
	},
});

export const toolchainDefinitions = {
	gcc: {
		executablePattern: /^(?:gcc|g\+\+)(?:-\d+(?:\.\d+)*)?(?:\.exe)?$/i,
		languageIdentifiers: cFamilyLanguageIdentifiers,
		intelSyntax: 'selectable',
		intelArguments: gnuIntelArguments,
		includeFlag: '-I',
		defineFlag: '-D',
		objectFilename: 'output.o',
		outputArguments: gnuOutputArguments(['-g1']),
		dependencyCollection: gnuDependencyCollection,
		createParser: defaultAsmParser,
		createCfgParser: () => new GccAssemblyCfgParser(new InstructionSetInfo()),
		discoverTools: toolDiscoverer({ demangler: 'c++filt', disassembler: 'objdump' }),
		artifacts: gccArtifacts,
	},
	'clang-cl': {
		executablePattern: /^clang-cl(?:\.exe)?$/i,
		languageIdentifiers: cFamilyLanguageIdentifiers,
		intelSyntax: 'inherent',
		includeFlag: '/I',
		defineFlag: '/D',
		objectFilename: 'output.obj',
		outputArguments: clangClOutputArguments,
		dependencyCollection: msvcDependencyCollection,
		createParser: defaultAsmParser,
		createCfgParser: () => new ClangAssemblyCfgParser(new InstructionSetInfo()),
		prepareEnvironment: captureWindowsEnvironment,
		demangle: windowsDemangle,
		discoverTools: toolDiscoverer({ demangler: 'llvm-cxxfilt', disassembler: 'llvm-objdump' }),
		artifacts: clangClArtifacts,
	},
	msvc: {
		executablePattern: /^cl\.exe$/i,
		languageIdentifiers: cFamilyLanguageIdentifiers,
		intelSyntax: 'inherent',
		includeFlag: '/I',
		defineFlag: '/D',
		objectFilename: 'output.obj',
		outputArguments: msvcOutputArguments,
		dependencyCollection: msvcDependencyCollection,
		createParser: createMsvcAsmParser,
		createCfgParser: () => new MsvcAssemblyCfgParser(),
		prepareEnvironment: captureWindowsEnvironment,
		demangle: windowsDemangle,
		discoverTools: toolDiscoverer({ demangler: 'undname', disassembler: 'dumpbin' }),
		artifacts: msvcArtifacts,
	},
	clang: {
		executablePattern: /^clang(?:\+\+)?(?:-\d+(?:\.\d+)*)?(?:\.exe)?$/i,
		languageIdentifiers: cFamilyLanguageIdentifiers,
		intelSyntax: 'selectable',
		intelArguments: gnuIntelArguments,
		includeFlag: '-I',
		defineFlag: '-D',
		objectFilename: 'output.o',
		outputArguments: gnuOutputArguments(['-gline-tables-only']),
		dependencyCollection: gnuDependencyCollection,
		createParser: defaultAsmParser,
		createCfgParser: () => new ClangAssemblyCfgParser(new InstructionSetInfo()),
		discoverTools: toolDiscoverer({ demangler: 'llvm-cxxfilt', disassembler: 'llvm-objdump' }),
		artifacts: clangArtifacts,
	},
	'apple-clang': {
		executablePattern: /^clang(?:\+\+)?(?:-\d+(?:\.\d+)*)?(?:\.exe)?$/i,
		disambiguate: (versionOutput, platform) => /apple clang/i.test(versionOutput) || platform === 'darwin',
		languageIdentifiers: cFamilyLanguageIdentifiers,
		intelSyntax: 'selectable',
		intelArguments: gnuIntelArguments,
		includeFlag: '-I',
		defineFlag: '-D',
		objectFilename: 'output.o',
		outputArguments: gnuOutputArguments(['-gline-tables-only']),
		dependencyCollection: gnuDependencyCollection,
		createParser: defaultAsmParser,
		createCfgParser: () => new ClangAssemblyCfgParser(new InstructionSetInfo()),
		discoverTools: toolDiscoverer({ demangler: 'llvm-cxxfilt', disassembler: 'llvm-objdump' }),
		artifacts: clangArtifacts,
	},
	rust: {
		executablePattern: /^rustc(?:\.exe)?$/i,
		languageIdentifiers: Object.freeze(['rust']),
		intelSyntax: 'selectable',
		intelArguments: rustIntelArguments,
		// rustc has no analogue of a C-style header search path, so unlike the
		// other toolchains this intentionally leaves `includeFlag` unset rather
		// than mapping it to something misleading; `defineFlag` maps CMake
		// compile definitions onto rustc's `--cfg`.
		defineFlag: '--cfg=',
		objectFilename: 'output.o',
		outputArguments: rustOutputArguments,
		stripOwnedArguments: stripRustManagedArguments,
		dependencyCollection: rustDependencyCollection,
		createParser: defaultAsmParser,
		createCfgParser: () => new ClangAssemblyCfgParser(new InstructionSetInfo()),
		discoverTools: toolDiscoverer({ demangler: 'rustfilt' }),
		artifacts: rustArtifacts,
	},
	python: {
		executablePattern: /^(?:python(?:\d+(?:\.\d+)*)?|py)(?:\.exe)?$/i,
		languageIdentifiers: Object.freeze(['python']),
		stripOwnedArguments: stripPythonManagedArguments,
		discoverTools: toolDiscoverer({}),
		artifacts: pythonArtifacts,
	},
	dotnet: {
		executablePattern: /^dotnet(?:\.exe)?$/i,
		languageIdentifiers: Object.freeze(['csharp']),
		stripOwnedArguments: stripDotNetManagedArguments,
		discoverTools: discoverDotNetTools,
		artifacts: dotNetArtifacts,
	},
	go: {
		executablePattern: /^go(?:\.exe)?$/i,
		languageIdentifiers: Object.freeze(['go']),
		stripOwnedArguments: stripGoManagedArguments,
		assembleArguments: (owned, provider, sourcePath) => [
			...owned.slice(0, 1),
			...provider,
			...owned.slice(1),
			sourcePath,
		],
		createParser: () => new GoAsmParser(noopPropertyGetter),
		discoverTools: toolDiscoverer({}),
		artifacts: goArtifacts,
	},
	zig: {
		executablePattern: /^zig(?:\.exe)?$/i,
		languageIdentifiers: Object.freeze(['zig']),
		intelSyntax: 'selectable',
		intelArguments: Object.freeze(['-mllvm', '--x86-asm-syntax=intel']),
		includeFlag: '-I',
		defineFlag: '-D',
		objectFilename: 'output.o',
		outputArguments: zigOutputArguments,
		stripOwnedArguments: stripZigManagedArguments,
		assembleArguments: (owned, provider, sourcePath) => [
			...owned.slice(0, 1),
			...provider,
			...owned.slice(1),
			sourcePath,
		],
		createParser: defaultAsmParser,
		createCfgParser: () => new ClangAssemblyCfgParser(new InstructionSetInfo()),
		discoverTools: toolDiscoverer({ demangler: 'llvm-cxxfilt', disassembler: 'llvm-objdump' }),
		artifacts: zigArtifacts,
	},
	nvcc: {
		executablePattern: /^nvcc(?:\.exe)?$/i,
		languageIdentifiers: Object.freeze(['cuda', 'cuda-cpp']),
		includeFlag: '-I',
		defineFlag: '-D',
		objectFilename: process.platform === 'win32' ? 'output.obj' : 'output.o',
		outputArguments: nvccOutputArguments,
		stripOwnedArguments: stripNvccManagedArguments,
		createParser: () => new PTXAsmParser(noopPropertyGetter),
		createBinaryParser: () => new SassAsmParser(noopPropertyGetter),
		...(process.platform === 'win32' ? { prepareEnvironment: captureWindowsEnvironment } : {}),
		discoverTools: toolDiscoverer({ disassembler: 'nvdisasm' }),
		artifacts: nvccArtifacts,
	},
} as const satisfies Record<string, ToolchainDefinitionShape>;

/**
 * Aliased to the shape (rather than derived from `typeof toolchainDefinitions`)
 * so that accessing a per-kind-optional field like `prepareEnvironment` doesn't
 * require narrowing a six-member union of distinct literal object types first.
 */
export function getToolchainDefinition(kind: ToolchainKind): ToolchainDefinition {
	return toolchainDefinitions[kind];
}

export function detectToolchainDefinition(
	executable: string,
	versionOutput = '',
	platform: NodeJS.Platform = process.platform,
): { kind: ToolchainKind; definition: ToolchainDefinition } | undefined {
	const executableName = path.basename(executable);
	const matches = supportedToolchainKinds.filter((kind) =>
		toolchainDefinitions[kind].executablePattern.test(executableName),
	);
	const kind =
		matches.find((candidate) => getToolchainDefinition(candidate).disambiguate?.(versionOutput, platform)) ??
		matches.find((candidate) => getToolchainDefinition(candidate).disambiguate === undefined);
	return kind ? { kind, definition: toolchainDefinitions[kind] } : undefined;
}

export const supportedToolchainKinds: readonly ToolchainKind[] = Object.keys(toolchainDefinitions) as ToolchainKind[];

export const supportedLanguageIdentifiers: ReadonlySet<string> = new Set(
	supportedToolchainKinds.flatMap((kind) => toolchainDefinitions[kind].languageIdentifiers),
);

export interface ToolchainProfileOverrides {
	readonly id?: string;
	readonly defaultArguments?: readonly string[];
	readonly environment?: Readonly<Record<string, string>>;
	readonly tools?: Readonly<Record<string, string>>;
}

export function createToolchainProfile(
	kind: ToolchainKind,
	displayName: string,
	executable: string,
	overrides: ToolchainProfileOverrides = {},
): ToolchainProfile {
	const definition = toolchainDefinitions[kind];
	const normalized = path.normalize(executable);
	const detectedTools = definition.discoverTools(normalized);
	return {
		id: overrides.id ?? normalizedExecutableLocalId(normalized),
		displayName,
		kind,
		executable: normalized,
		defaultArguments: overrides.defaultArguments ?? [],
		environment: overrides.environment ?? {},
		tools: Object.freeze({
			...detectedTools,
			...overrides.tools,
		}),
	};
}

export function resolveArtifactAvailability(profile: ToolchainProfile, kind: ArtifactKind): ToolchainArtifactCell {
	const cell: ToolchainArtifactCell = toolchainDefinitions[profile.kind].artifacts[kind];
	if (cell.status === 'available' && cell.outputs) {
		return cell;
	}
	return resolveImplementationAvailability(profile, cell);
}

/** The named compiler outputs from which this artifact can be produced. */
export function getArtifactOutputChoices(
	profile: ToolchainProfile,
	kind: ArtifactKind,
): readonly Pick<ToolchainArtifactOutput, 'id' | 'label' | 'description'>[] {
	const cell = resolveArtifactAvailability(profile, kind);
	if (cell.status !== 'available' || cell.outputs === undefined) {
		return [];
	}
	return cell.outputs.map(({ id, label, description }) => ({ id, label, description }));
}

/** Resolve the producer for an explicit compiler-output selection. */
export function resolveArtifactOutput(
	profile: ToolchainProfile,
	kind: ArtifactKind,
	outputId?: string,
): ResolvedToolchainArtifactCell {
	const cell: ToolchainArtifactCell = toolchainDefinitions[profile.kind].artifacts[kind];
	if (cell.status !== 'available') {
		return resolveImplementationAvailability(profile, cell);
	}
	if (cell.outputs === undefined) {
		if (outputId !== undefined) {
			return {
				status: 'unsupported',
				explanation: `${artifactDefinitions[kind].label} does not accept an output selection.`,
			};
		}
		return resolveImplementationAvailability(profile, cell);
	}
	if (outputId === undefined) {
		return {
			status: 'unsupported',
			explanation: `Select an output for ${artifactDefinitions[kind].label.toLowerCase()}.`,
		};
	}
	const output = cell.outputs.find((candidate) => candidate.id === outputId);
	if (output === undefined) {
		return {
			status: 'unsupported',
			explanation: `${profile.displayName} does not support the ${outputId} output for ${artifactDefinitions[kind].label.toLowerCase()}.`,
		};
	}
	return resolveImplementationAvailability(profile, {
		status: 'available',
		...output,
	});
}

function resolveImplementationAvailability(
	profile: ToolchainProfile,
	cell: ResolvedToolchainArtifactCell,
): ResolvedToolchainArtifactCell {
	const requiredTools =
		cell.status === 'available'
			? [...(cell.requiredTool ? [cell.requiredTool] : []), ...(cell.requiredTools ?? [])]
			: [];
	const missingTool = requiredTools.find((tool) => !profile.tools[tool.name]);
	if (cell.status === 'available' && missingTool) {
		return {
			status: 'unavailable',
			explanation:
				`${missingTool.label} was not detected or configured as the ` +
				`${missingTool.name} auxiliary tool for ${profile.displayName}.`,
		};
	}
	return cell;
}

export function resolveArtifactOptionAvailability(
	profile: ToolchainProfile,
	kind: ArtifactKind,
	id: ArtifactOptionId,
): ArtifactOptionAvailability {
	const cell = getToolchainDefinition(profile.kind).artifacts[kind];
	const definition = artifactDefinitions[kind];
	if (
		cell.status === 'available' &&
		cell.outputs === undefined &&
		(cell.listingSyntax ?? definition.listingSyntax) !== definition.listingSyntax
	) {
		const listingSyntax = cell.listingSyntax?.replaceAll('-', ' ') ?? 'toolchain-specific output';
		const defaultListingSyntax = definition.listingSyntax?.replaceAll('-', ' ') ?? 'the default listing syntax';
		return {
			status: 'unsupported',
			explanation: `${profile.displayName} emits ${listingSyntax} rather than ${defaultListingSyntax}.`,
		};
	}
	const artifact = resolveArtifactAvailability(profile, kind);
	if (artifact.status !== 'available') {
		return artifact;
	}
	if (id === 'demangle') {
		return profile.tools.demangler
			? { status: 'available' }
			: {
					status: 'unavailable',
					explanation: `No demangler was detected or configured for ${profile.displayName}.`,
				};
	}
	if (id === 'intel') {
		const intelSyntax = getToolchainDefinition(profile.kind).intelSyntax ?? 'unsupported';
		if (intelSyntax === 'selectable') {
			return { status: 'available' };
		}
		return intelSyntax === 'inherent'
			? {
					status: 'unavailable',
					explanation: `${profile.displayName} already emits Intel syntax.`,
					reason: 'inherent',
				}
			: {
					status: 'unsupported',
					explanation: `${profile.displayName} does not support selectable Intel syntax.`,
				};
	}
	return { status: 'available' };
}

export function normalizedExecutableLocalId(executable: string): string {
	const normalized = path.resolve(executable);
	return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
