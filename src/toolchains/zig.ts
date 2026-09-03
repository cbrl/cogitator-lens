import path from 'node:path';
import { artifactProducer } from '../artifacts/core/compiler-output-producer.js';
import { parseLlvmControlFlowGraphs } from '../artifacts/control-flow-graph/parsers/llvm-ir-cfg-parser.js';
import { ClangAssemblyCfgParser } from '../artifacts/control-flow-graph/parsers/assembly-dialects.js';
import { InstructionSetInfo } from '../artifacts/control-flow-graph/parsers/instruction-sets.js';
import {
	artifactCells,
	assemblyCell,
	assemblyControlFlowGraphOutput,
	controlFlowGraphOutput,
	outputArtifactCell,
	toolDiscoverer,
	type ToolchainDefinition,
} from './toolchain-contracts.js';
import { defaultAsmParser } from './c-family.js';
import { parseGnuDiagnostics } from './c-family/diagnostics.js';
import { sameLocalFile } from '../local-file-identity.js';

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
	const result: string[] = [];
	for (let index = 0; index < args.length; index++) {
		const argument = args[index];
		if (index === 0 && /^build-(?:obj|exe|lib)$/u.test(argument)) {
			continue;
		}
		if (sameLocalFile(argument, sourceFile, workingDirectory)) {
			continue;
		}
		if (['--cache-dir', '--global-cache-dir', '--name'].includes(argument)) {
			index++;
			continue;
		}
		if (/^(?:--(?:cache-dir|global-cache-dir|name)=|-f(?:no-)?emit-(?:bin|asm|llvm-ir)(?:=|$))/u.test(argument)) {
			continue;
		}
		result.push(argument);
	}
	return result;
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
	assembleArguments: (owned, provider, sourcePath) => [
		...owned.slice(0, 1),
		...provider,
		...owned.slice(1),
		sourcePath,
	],
	createParser: defaultAsmParser,
	createCfgParser: () => new ClangAssemblyCfgParser(new InstructionSetInfo()),
	discoverTools: toolDiscoverer({ demangler: 'llvm-cxxfilt', disassembler: 'llvm-objdump' }),
	artifacts: artifactCells({
		assembly: assemblyCell,
		'llvm-ir': { status: 'available', producer: artifactProducer('llvm-ir', zigLlvmIrOutput) },
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
	}),
};
