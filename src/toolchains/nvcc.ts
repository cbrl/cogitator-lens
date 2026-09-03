import path from 'node:path';
import type { BinaryDisassembler } from './toolchain-backend.js';
import { noopPropertyGetter } from '../vendor/compiler-props.js';
import { PTXAsmParser } from '../vendor/lib/parsers/asm-parser-ptx.js';
import { SassAsmParser } from '../vendor/lib/parsers/asm-parser-sass.js';
import { binaryDisassemblyProducer } from '../artifacts/binary-disassembly/binary-disassembly-producer.js';
import {
	artifactCells,
	assemblyCell,
	binaryCell,
	toolDiscoverer,
	type ToolchainDefinition,
} from './toolchain-contracts.js';
import { gnuPreprocessedSourceProducer } from './c-family.js';
import { captureWindowsEnvironment } from './msvc.js';
import { composeDiagnosticParsers } from '../diagnostics.js';
import { parseGnuDiagnostics } from './c-family/diagnostics.js';
import { parseParenthesizedDiagnostics } from './msvc/diagnostics.js';
import { sameLocalFile } from '../local-file-identity.js';

// Managed arguments that do not have a separate value (i.e. have no value or use the --arg=xyz form).
const managedArgsUnitary =
	/^(?:-o.+|--output-file=|--ptx$|-ptx$|--cubin$|-cubin$|--compile$|-c$|-S$|-E$|--generate-line-info$|-lineinfo$|--keep-device-functions$)/u;

/** Builds nvcc arguments that emit line-mapped PTX or a cubin for disassembly. */
export function nvccOutputArguments(target: 'assembly' | 'object', outputFile: string): readonly string[] {
	return target === 'assembly'
		? ['--ptx', '--generate-line-info', '--keep-device-functions', '-o', outputFile]
		: ['--cubin', '--generate-line-info', '--keep-device-functions', '-o', outputFile];
}

export const nvdisasm: BinaryDisassembler = Object.freeze({
	tool: 'disassembler',
	arguments: (binaryFile: string) => [binaryFile, '-c', '-g', '-hex'],
});

/** Removes nvcc output switches and the source path owned by artifact production. */
export function stripNvccManagedArguments(
	args: readonly string[],
	sourceFile: string,
	workingDirectory: string,
): string[] {
	const result: string[] = [];
	for (let index = 0; index < args.length; index++) {
		const argument = args[index];
		if (sameLocalFile(argument, sourceFile, workingDirectory)) {
			continue;
		}
		if (['-o', '--output-file'].includes(argument)) {
			index++;
			continue;
		}
		if (managedArgsUnitary.test(argument)) {
			continue;
		}
		result.push(argument);
	}
	return result;
}

export const nvcc: ToolchainDefinition = {
	executablePattern: /^nvcc(?:\.exe)?$/i,
	parseDiagnostics: composeDiagnosticParsers(parseParenthesizedDiagnostics, parseGnuDiagnostics),
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
	artifacts: artifactCells({
		assembly: assemblyCell,
		'binary-disassembly': binaryCell('nvdisasm', binaryDisassemblyProducer(nvdisasm)),
		'preprocessed-source': { status: 'available', producer: gnuPreprocessedSourceProducer },
	}),
};
