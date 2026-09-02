import type { CancellationToken, Uri } from 'vscode';
import type { CompileOptions, RawArtifact } from '../../types/index.js';
import type { BinaryDisassembler, ToolchainBackend } from '../../toolchains/toolchain-backend.js';

export function binaryDisassemblyProducer(
	disassembler: BinaryDisassembler,
): (
	backend: ToolchainBackend,
	source: Uri,
	options: CompileOptions,
	cancellationToken: CancellationToken,
) => Promise<RawArtifact> {
	return (backend, source, options, cancellationToken) =>
		backend.produceBinaryDisassembly(source, options, disassembler, cancellationToken);
}

export const gnuObjdump: BinaryDisassembler = Object.freeze({
	tool: 'disassembler',
	arguments: (objectFile: string) => ['-d', '-l', '-w', objectFile],
	normalizeOutput: normalizeDisassemblySourcePaths,
});

export const llvmObjdump: BinaryDisassembler = Object.freeze({
	tool: 'disassembler',
	arguments: (objectFile: string) => ['--disassemble', '--line-numbers', objectFile],
	normalizeOutput: normalizeDisassemblySourcePaths,
});


export function normalizeDisassemblySourcePaths(output: string): string {
	return output
		.split(/\r?\n/)
		.map((line) => {
			const source = /^([a-z]):[\\/](.*):(\d+)(.*)$/i.exec(line);
			return source
				? `${source[1].toUpperCase()}:/${source[2].replaceAll('\\', '/')}:${source[3]}${source[4]}`
				: line;
		})
		.join('\n');
}
