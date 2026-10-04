import { outputProducer } from '../artifacts/core/compiler-output-producer.js';
import { parseLlvmControlFlowGraphs } from '../artifacts/control-flow-graph/parsers/llvm-ir-cfg-parser.js';
import { ClangAssemblyCfgParser } from '../artifacts/control-flow-graph/parsers/assembly-dialects.js';
import { InstructionSetInfo } from '../artifacts/control-flow-graph/parsers/instruction-sets.js';
import {
	compilerAssembly,
	assemblyControlFlowGraphOutput,
	controlFlowGraphOutput,
	subcommandFirst,
	toolDiscoverer,
	type ToolchainDefinition,
	withoutOwnedArguments,
} from './toolchain-contracts.js';
import { defaultAsmParser } from './c-family.js';
import { parseGnuDiagnostics } from './c-family/diagnostics.js';

/** Builds Zig \`build-obj\` arguments that emit assembly or an object file into the workspace. */
export function zigOutputArguments(target: 'assembly' | 'object', outputFile: string): readonly string[] {
	return target === 'assembly'
		? ['build-obj', '-fllvm', '-fno-strip', '-fno-emit-bin', `-femit-asm=${outputFile}`]
		: ['build-obj', '-fllvm', '-fno-strip', `-femit-bin=${outputFile}`];
}

export const zigLlvmIrOutput = Object.freeze({
	output: { filename: 'output.ll' },
	arguments: (outputFile: string) => [
		'build-obj',
		'-fllvm',
		'-fno-strip',
		'-fno-emit-bin',
		`-femit-llvm-ir=${outputFile}`,
	],
});

/** Removes backend-owned subcommands, cache paths, emit flags, and the source path. */
export function stripZigManagedArguments(
	args: readonly string[],
	sourceFile: string,
	workingDirectory: string,
): string[] {
	return withoutOwnedArguments(args, sourceFile, workingDirectory, {
		withValue: [new Set(['--cache-dir', '--global-cache-dir', '--name'])],
		standalone: [
			(argument, index) => index === 0 && /^build-(?:obj|exe|lib)$/u.test(argument),
			/^(?:--(?:cache-dir|global-cache-dir|name)=|-f(?:no-)?emit-(?:bin|asm|llvm-ir)(?:=|$))/u,
		],
	});
}

export const zig: ToolchainDefinition = {
	executablePattern: /^zig(?:\.exe)?$/i,
	parseDiagnostics: parseGnuDiagnostics,
	languageIdentifiers: Object.freeze(['zig']),
	intelSyntax: 'selectable',
	intelArguments: Object.freeze(['-mllvm', '--x86-asm-syntax=intel']),
	includeFlag: '-I',
	defineFlag: '-D',
	objectFilename: 'output.o',
	outputArguments: zigOutputArguments,
	stripOwnedArguments: stripZigManagedArguments,
	assembleArguments: subcommandFirst,
	createParser: defaultAsmParser,
	createCfgParser: () => new ClangAssemblyCfgParser(new InstructionSetInfo()),
	discoverTools: toolDiscoverer({ demangler: 'llvm-cxxfilt', disassembler: 'llvm-objdump' }),
	artifacts: {
		assembly: compilerAssembly,
		'llvm-ir': { producer: outputProducer(zigLlvmIrOutput) },
		'control-flow-graph': {
			outputs: [
				controlFlowGraphOutput(
					'llvm-ir',
					'LLVM IR CFG',
					'Build a graph from Zig LLVM IR output.',
					outputProducer(zigLlvmIrOutput),
					(raw) => parseLlvmControlFlowGraphs(raw.text, raw.command.cwd),
				),
				assemblyControlFlowGraphOutput,
			],
		},
	},
};
