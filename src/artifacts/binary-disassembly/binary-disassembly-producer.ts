import type { ArtifactProducer } from '../../toolchains/toolchain-contracts.js';

export interface BinaryDisassembler {
	/** The key of the auxiliary tool in the toolchain profile. */
	readonly tool: string;
	readonly arguments: (objectFile: string) => readonly string[];
	readonly normalizeOutput?: (output: string) => string;
}

/** Compiles the source to an object file, then disassembles it with the auxiliary tool. */
export function binaryDisassemblyProducer(disassembler: BinaryDisassembler): ArtifactProducer {
	return (backend, source, options, cancellationToken) => {
		const { outputArguments, objectFilename } = backend.definition;
		if (!outputArguments || !objectFilename) {
			throw new Error(`${backend.profile.displayName} has no object-file production capability.`);
		}
		return backend.produceWithTool(
			source,
			options,
			{
				workspaceFiles: { object: objectFilename },
				compilerArguments: (files, providerArguments) =>
					outputArguments('object', files.object, providerArguments),
				tool: disassembler.tool,
				toolArguments: (files) => disassembler.arguments(files.object),
				normalizeOutput: disassembler.normalizeOutput,
			},
			cancellationToken,
		);
	};
}

export const gnuObjdump: BinaryDisassembler = Object.freeze({
	tool: 'disassembler',
	arguments: (objectFile: string) => ['-d', '-l', '-w', objectFile],
	normalizeOutput: normalizeDisassemblySourcePaths,
});

export const llvmObjdump: BinaryDisassembler = Object.freeze({
	tool: 'disassembler',
	arguments: (objectFile: string) => ['--disassemble', '--line-numbers', objectFile],
	normalizeOutput: (output: string) => normalizeDisassemblySourcePaths(withoutLineMarkerComments(output)),
});

/**
 * llvm-objdump prints line markers as "; /path/file.cpp:12". The parser reads only GNU objdump's
 * unprefixed form, so it would map no line to its source.
 */
export function withoutLineMarkerComments(output: string): string {
	return output.replace(/^; (?=(?:[A-Za-z]:)?[\\/].*:\d+\s*$)/gm, '');
}

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
