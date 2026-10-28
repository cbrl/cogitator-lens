import path from 'path';
import type { BinaryDisassembler } from '../artifacts/binary-disassembly/binary-disassembly-producer.js';
import { noopPropertyGetter } from '../vendor/compiler-props.js';
import { PTXAsmParser } from '../vendor/lib/parsers/asm-parser-ptx.js';
import { SassAsmParser } from '../vendor/lib/parsers/asm-parser-sass.js';
import {
	compilerAssembly,
	binaryDisassembly,
	toolDiscoverer,
	type ToolchainDefinition,
	withoutOwnedArguments,
} from './toolchain-contracts.js';
import { gnuPreprocessedSourceProducer } from './c-family.js';
import { captureWindowsEnvironment } from './msvc.js';
import { composeDiagnosticParsers } from '../diagnostics.js';
import { parseGnuDiagnostics } from './c-family/diagnostics.js';
import { parseParenthesizedDiagnostics } from './msvc/diagnostics.js';

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

/**
 * Returns the host compiler that `-ccbin` or `--compiler-bindir` names, as a cl.exe path. The last
 * switch wins, as in nvcc. The switch can name the compiler or its directory.
 */
export function nvccHostCompiler(args: readonly string[]): string | undefined {
	let hostCompiler: string | undefined;
	args.forEach((argument, index) => {
		const joined = /^(?:-ccbin|--compiler-bindir)=(.+)$/u.exec(argument)?.[1];
		const separate =
			(argument === '-ccbin' || argument === '--compiler-bindir') && index + 1 < args.length
				? args[index + 1]
				: undefined;
		hostCompiler = joined ?? separate ?? hostCompiler;
	});
	return hostCompiler && (/\.exe$/iu.test(hostCompiler) ? hostCompiler : path.win32.join(hostCompiler, 'cl.exe'));
}

/**
 * Loads the Visual Studio environment of the host compiler. A CUDA release accepts only some MSVC
 * toolsets, so `-ccbin` can name an older one than the default.
 */
export const prepareNvccEnvironment: NonNullable<ToolchainDefinition['prepareEnvironment']> = (
	profile,
	environment,
	cancellationToken,
	providerArguments,
) => {
	const hostCompiler = nvccHostCompiler(providerArguments);
	return captureWindowsEnvironment(
		hostCompiler ? { ...profile, executable: hostCompiler } : profile,
		environment,
		cancellationToken,
	);
};

/** Removes nvcc output switches and the source path owned by artifact production. */
export function stripNvccManagedArguments(
	args: readonly string[],
	sourceFile: string,
	workingDirectory: string,
): string[] {
	return withoutOwnedArguments(args, sourceFile, workingDirectory, {
		withValue: [new Set(['-o', '--output-file'])],
		standalone: [managedArgsUnitary],
	});
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
	...(process.platform === 'win32' ? { prepareEnvironment: prepareNvccEnvironment } : {}),
	discoverTools: toolDiscoverer({ disassembler: 'nvdisasm' }),
	artifacts: {
		assembly: compilerAssembly,
		'binary-disassembly': binaryDisassembly('nvdisasm', nvdisasm),
		'preprocessed-source': { producer: gnuPreprocessedSourceProducer },
	},
};
