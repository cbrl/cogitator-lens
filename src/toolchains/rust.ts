import { parseMakeDepfile } from '../compilation/artifact-inputs.js';
import { outputProducer } from '../artifacts/core/compiler-output-producer.js';
import { parseRustMirControlFlowGraphs } from '../artifacts/control-flow-graph/parsers/rust-mir-cfg-parser.js';
import { parseLlvmControlFlowGraphs } from '../artifacts/control-flow-graph/parsers/llvm-ir-cfg-parser.js';
import { ClangAssemblyCfgParser } from '../artifacts/control-flow-graph/parsers/assembly-dialects.js';
import { InstructionSetInfo } from '../artifacts/control-flow-graph/parsers/instruction-sets.js';
import { hasOption } from '../utils.js';
import type { ArtifactOutputSpec, DependencyCollectionSpec } from './toolchain-backend.js';
import {
	compilerAssembly,
	assemblyControlFlowGraphOutput,
	controlFlowGraphOutput,
	toolDiscoverer,
	type ToolchainDefinition,
} from './toolchain-contracts.js';
import { defaultAsmParser, stripCompilerManagedArguments } from './c-family.js';
import { parseRustDiagnostics } from './rust/diagnostics.js';

const rustManagedFlagsWithValues = new Set(['--emit', '--error-format', '--json', '--out-dir', '--color']);
const rustManagedFlagAssignments = /^(?:--emit|--error-format|--json|--out-dir|--color)=/;

/** Supplies crate metadata required by standalone rustc invocations unless the provider specifies it. */
function rustDefaults(providerArguments: readonly string[]): readonly string[] {
	return [
		...(hasOption(providerArguments, '--crate-name') ? [] : ['--crate-name=coglens_artifact']),
		...(hasOption(providerArguments, '--crate-type') ? [] : ['--crate-type=lib']),
	];
}

/** Builds rustc assembly/object arguments while supplying stable crate defaults when absent. */
export function rustOutputArguments(
	target: 'assembly' | 'object',
	outputFile: string,
	providerArguments: readonly string[],
): readonly string[] {
	return [
		...rustDefaults(providerArguments),
		target === 'assembly' ? '--emit=asm' : '--emit=obj',
		'-C',
		'debuginfo=1',
		'--error-format=human',
		'--color=never',
		'-o',
		outputFile,
	];
}

/** Builds rustc \`--emit\` arguments for MIR or LLVM IR files. */
export function rustArtifactArguments(
	emit: 'mir' | 'llvm-ir',
	outputFile: string,
	providerArguments: readonly string[],
): readonly string[] {
	return [
		...rustDefaults(providerArguments),
		`--emit=${emit}=${outputFile}`,
		...(emit === 'llvm-ir' ? ['-C', 'debuginfo=1'] : []),
		'--error-format=human',
		'--color=never',
	];
}

export const rustMirOutput: ArtifactOutputSpec = Object.freeze({
	output: { filename: 'output.mir' },
	arguments: (outputFile: string, _temporaryDirectory: string, providerArguments: readonly string[]) =>
		rustArtifactArguments('mir', outputFile, providerArguments),
});

export const rustLlvmIrOutput: ArtifactOutputSpec = Object.freeze({
	output: { filename: 'output.ll' },
	arguments: (outputFile: string, _temporaryDirectory: string, providerArguments: readonly string[]) =>
		rustArtifactArguments('llvm-ir', outputFile, providerArguments),
});

/** Removes backend-managed Rust output flags in addition to shared compiler-managed arguments. */
export function stripRustManagedArguments(
	args: readonly string[],
	sourceFile: string,
	workingDirectory?: string,
): string[] {
	const stripped = stripCompilerManagedArguments(args, sourceFile, workingDirectory);
	const result: string[] = [];
	for (let index = 0; index < stripped.length; index++) {
		const argument = stripped[index];
		if (rustManagedFlagsWithValues.has(argument)) {
			index++;
			continue;
		}
		if (rustManagedFlagAssignments.test(argument)) {
			continue;
		}
		result.push(argument);
	}
	return result;
}

const rustDependencyCollection: DependencyCollectionSpec = Object.freeze({
	outputFilename: 'dependencies.d',
	arguments: (outputFile: string, _temporaryDirectory: string, providerArguments: readonly string[]) => [
		...rustDefaults(providerArguments),
		`--emit=dep-info=${outputFile}`,
		'--error-format=human',
		'--color=never',
	],
	parse: parseMakeDepfile,
});

export const rust: ToolchainDefinition = {
	executablePattern: /^rustc(?:\.exe)?$/i,
	parseDiagnostics: parseRustDiagnostics,
	languageIdentifiers: Object.freeze(['rust']),
	intelSyntax: 'selectable',
	intelArguments: Object.freeze(['-C', 'llvm-args=-x86-asm-syntax=intel']),
	defineFlag: '--cfg=',
	objectFilename: 'output.o',
	outputArguments: rustOutputArguments,
	stripOwnedArguments: stripRustManagedArguments,
	dependencyCollection: rustDependencyCollection,
	createParser: defaultAsmParser,
	createCfgParser: () => new ClangAssemblyCfgParser(new InstructionSetInfo()),
	discoverTools: toolDiscoverer({ demangler: 'rustfilt' }),
	artifacts: {
		assembly: compilerAssembly,
		'llvm-ir': { producer: outputProducer(rustLlvmIrOutput) },
		'rust-mir': { producer: outputProducer(rustMirOutput) },
		'control-flow-graph': {
			outputs: [
				controlFlowGraphOutput(
					'rust-mir',
					'Rust MIR CFG',
					'Build a source-level graph from rustc MIR output.',
					outputProducer(rustMirOutput),
					(raw) => parseRustMirControlFlowGraphs(raw.text, raw.command.cwd),
				),
				controlFlowGraphOutput(
					'llvm-ir',
					'LLVM IR CFG',
					'Build a graph from rustc LLVM IR output.',
					outputProducer(rustLlvmIrOutput),
					(raw) => parseLlvmControlFlowGraphs(raw.text, raw.command.cwd),
				),
				assemblyControlFlowGraphOutput,
			],
		},
	},
};
