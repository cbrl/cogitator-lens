import type { ArtifactProducer } from '../../toolchains/toolchain-contracts.js';

export interface BinaryDisassembler {
	/** The key of the auxiliary tool in the toolchain profile. */
	readonly tool: string;
	readonly arguments: (objectFile: string) => readonly string[];
	/** Converts the tool output to the GNU objdump shape. The object file still exists. */
	readonly normalizeOutput?: (output: string, objectFile: string) => string | Promise<string>;
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
				normalizeOutput: (output, files) => disassembler.normalizeOutput?.(output, files.object) ?? output,
			},
			cancellationToken,
		);
	};
}

/**
 * In an object file, a call to another function holds no target until it is linked. The
 * relocations name the function, and with `-w` each one is at the end of its instruction line.
 */
export const gnuObjdump: BinaryDisassembler = Object.freeze({
	tool: 'disassembler',
	arguments: (objectFile: string) => ['-d', '-l', '-w', '-r', objectFile],
	normalizeOutput: normalizeDisassemblySourcePaths,
});

export const llvmObjdump: BinaryDisassembler = Object.freeze({
	tool: 'disassembler',
	arguments: (objectFile: string) => ['--disassemble', '--line-numbers', '--reloc', objectFile],
	normalizeOutput: normalizeLlvmObjdumpOutput,
});

export function normalizeLlvmObjdumpOutput(output: string): string {
	return normalizeDisassemblySourcePaths(withInlineRelocations(withoutLineMarkerComments(output)));
}

/** An instruction line: its address and its bytes. */
const instructionLine = /^\s*[\da-f]+:(?:\s[\da-f]{2})+\s/;
/** A relocation on a line of its own: its offset, its type, and its symbol with an addend. */
const relocationLine = /^\s+0*([\da-f]+?):\s+([A-Za-z][A-Za-z\d]*_\w+)\s+(.+?)\s*$/;

/**
 * Moves each relocation to the end of its instruction line, where GNU objdump writes it with
 * `-w`. llvm-objdump writes it on the next line. On a line of its own, the parser keeps only an
 * ELF relocation, because the type of a COFF or Mach-O relocation does not start with `R_`.
 */
export function withInlineRelocations(output: string): string {
	const lines: string[] = [];
	for (const line of output.split(/\r?\n/)) {
		const relocation = relocationLine.exec(line);
		if (relocation && lines.length > 0 && instructionLine.test(lines[lines.length - 1])) {
			lines[lines.length - 1] += `\t${relocation[1]}: ${relocation[2]}\t${relocation[3]}`;
		} else {
			lines.push(line);
		}
	}
	return lines.join('\n');
}

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
