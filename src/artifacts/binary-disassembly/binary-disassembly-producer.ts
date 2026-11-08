import path from 'node:path';
import type { CancellationToken } from 'vscode';
import { execute } from '../../exec.js';
import type { ArtifactProducer } from '../../toolchains/toolchain-contracts.js';
import { executeTextTool, type ToolRunContext } from '../../toolchains/toolchain-backend.js';
import type { AuxiliaryTool } from '../../types/index.js';
import { parseObjdumpSections, type ObjectSection } from '../code-size/object-sections.js';

export interface BinaryDisassembler {
	/** The key of the auxiliary tool in the toolchain profile. */
	readonly tool: string;
	readonly arguments: (objectFile: string) => readonly string[];
	/** Converts the tool output to the GNU objdump shape. The object file still exists. */
	readonly normalizeOutput?: (output: string, objectFile: string) => string | Promise<string>;
	/** How the same tool lists the sections of the object file, with their sizes. */
	readonly sections?: {
		readonly arguments: (objectFile: string) => readonly string[];
		readonly parse: (output: string) => readonly ObjectSection[];
	};
}

/** The data that the disassembly keeps for its renderers: the sections of the object file. */
export interface DisassemblyData {
	readonly sections?: readonly ObjectSection[];
}

const producers = new WeakMap<BinaryDisassembler, ArtifactProducer>();

/**
 * Compiles the source to an object file, then disassembles it with the auxiliary tool. The same
 * tool also lists the sections of the object file. One disassembler has one producer, so the binary
 * disassembly and the code size of a source share one compile.
 */
export function binaryDisassemblyProducer(disassembler: BinaryDisassembler): ArtifactProducer {
	let producer = producers.get(disassembler);
	if (producer) {
		return producer;
	}
	producer = (backend, source, options, cancellationToken) => {
		const { outputArguments, objectFilename } = backend.definition;
		if (!outputArguments || !objectFilename) {
			throw new Error(`${backend.profile.displayName} has no object-file production capability.`);
		}
		const demangler = options.productionOptions.demangle ? backend.profile.tools.demangler : undefined;
		return backend.produceWithTool(
			source,
			options,
			{
				workspaceFiles: { object: objectFilename },
				compilerArguments: (files, providerArguments) =>
					outputArguments('object', files.object, providerArguments),
				tool: disassembler.tool,
				toolArguments: (files) => disassembler.arguments(files.object),
				producerData: async (files, run): Promise<DisassemblyData> => {
					const sections = await objectSections(
						disassembler,
						files.object,
						backend.profile.tools,
						run,
						cancellationToken,
					);
					return sections ? { sections } : {};
				},
				normalizeOutput: async (output, files) => {
					const normalized = (await disassembler.normalizeOutput?.(output, files.object)) ?? output;
					return demangler
						? executeTextTool(
								normalized,
								demangler,
								{ ...process.env, ...backend.profile.environment, ...options.env },
								options.workingDirectory ?? path.dirname(source.fsPath),
								cancellationToken,
							)
						: normalized;
				},
			},
			cancellationToken,
		);
	};
	producers.set(disassembler, producer);
	return producer;
}

/**
 * The sections of the object file, from the section listing of the disassembler. Without a section
 * listing, or when it fails, the result is nothing, and the disassembly does not fail.
 */
async function objectSections(
	disassembler: BinaryDisassembler,
	objectFile: string,
	tools: Readonly<Record<string, AuxiliaryTool>>,
	run: ToolRunContext,
	cancellationToken: CancellationToken,
): Promise<readonly ObjectSection[] | undefined> {
	const tool = tools[disassembler.tool];
	if (!disassembler.sections || !tool) {
		return undefined;
	}
	try {
		const result = await execute(tool.executable, [...disassembler.sections.arguments(objectFile)], {
			cwd: run.workingDirectory,
			env: run.environment,
			cancellationToken,
		});
		return result.returnCode === 0 ? disassembler.sections.parse(result.stdout) : undefined;
	} catch (error) {
		if (cancellationToken.isCancellationRequested) {
			throw error;
		}
		return undefined;
	}
}

/** GNU objdump and llvm-objdump list the sections with `-h`. */
const objdumpSections = Object.freeze({
	arguments: (objectFile: string) => ['-h', objectFile],
	parse: parseObjdumpSections,
});

/**
 * In an object file, a call to another function holds no target until it is linked. The
 * relocations name the function, and with `-w` each one is at the end of its instruction line.
 */
export const gnuObjdump: BinaryDisassembler = Object.freeze({
	tool: 'disassembler',
	arguments: (objectFile: string) => ['-d', '-l', '-w', '-r', objectFile],
	normalizeOutput: normalizeDisassemblySourcePaths,
	sections: objdumpSections,
});

export const llvmObjdump: BinaryDisassembler = Object.freeze({
	tool: 'disassembler',
	arguments: (objectFile: string) => ['--disassemble', '--line-numbers', '--reloc', objectFile],
	normalizeOutput: normalizeLlvmObjdumpOutput,
	sections: objdumpSections,
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
