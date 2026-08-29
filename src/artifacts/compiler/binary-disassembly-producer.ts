import type { CancellationToken, Uri } from 'vscode';
import type {
	CompileOptions,
	RawArtifact,
} from '../../types/index.js';
import type {
	BinaryDisassembler,
	ToolchainBackend,
} from '../../toolchains/toolchain-backend.js';

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
	arguments: (objectFile: string) => [
		'--disassemble',
		'--line-numbers',
		objectFile,
	],
	normalizeOutput: normalizeDisassemblySourcePaths,
});

export const dumpbin: BinaryDisassembler = Object.freeze({
	tool: 'disassembler',
	arguments: (objectFile: string) => ['/nologo', '/disasm:bytes', '/linenumbers', objectFile],
	normalizeOutput: normalizeDumpbinOutput,
});

/**
 * Converts dumpbin's symbol headings and instruction rows to the GNU-style
 * shape consumed by the vendored raw-assembly parser.
 */
export function normalizeDumpbinOutput(output: string): string {
	const normalized: string[] = [];
	let pendingSymbol: string | undefined;
	let pendingSource: string | undefined;

	for (const originalLine of output.split(/\r?\n/)) {
		const line = originalLine.trimEnd();
		const instruction = /^\s*([0-9a-f]+):\s*((?:[0-9a-f]{2}\s+)+)(.*)$/i.exec(line);
		if (instruction) {
			const address = instruction[1].toLowerCase();
			if (pendingSymbol) {
				normalized.push(`${address} <${pendingSymbol}>:`);
				pendingSymbol = undefined;
			}
			if (pendingSource) {
				normalized.push(pendingSource);
				pendingSource = undefined;
			}
			normalized.push(`${address}: ${instruction[2].toLowerCase()}${instruction[3]}`);
			continue;
		}

		const addressAndSymbol = /^\s*([0-9a-f]+)\s+<?([^<>:]+)>?:\s*$/i.exec(line);
		if (addressAndSymbol) {
			normalized.push(
				`${addressAndSymbol[1].toLowerCase()} <${addressAndSymbol[2].trim()}>:`,
			);
			pendingSymbol = undefined;
			pendingSource = undefined;
			continue;
		}

		const symbol = /^\s*([?$@A-Z_a-z][^:]*):\s*$/.exec(line);
		if (symbol) {
			const heading = symbol[1].trim();
			pendingSymbol = /^(\S+)\s+\(/.exec(heading)?.[1] ?? heading;
			continue;
		}

		const source = /^\s*(.+\.[A-Za-z0-9_+-]+)\((\d+)\)\s*$/.exec(line);
		if (source) {
			const normalizedSource = normalizeDisassemblySourcePaths(`${source[1]}:${source[2]}`);
			if (pendingSymbol) {
				pendingSource = normalizedSource;
			} else {
				normalized.push(normalizedSource);
			}
		}
	}

	const symbolByAddress = new Map<string, string>();
	const addressBySymbol = new Map<string, string>();
	for (const line of normalized) {
		const label = /^([0-9a-f]+) <(.+)>:$/.exec(line);
		if (label) {
			symbolByAddress.set(canonicalAddress(label[1]), label[2]);
			addressBySymbol.set(label[2], label[1]);
		}
	}
	return normalized.map(line => {
		const numericBranch = /\b(?:call|j[a-z]+)\s+([0-9a-f]+)$/i.exec(line);
		const numericSymbol = numericBranch
			? symbolByAddress.get(canonicalAddress(numericBranch[1]))
			: undefined;
		if (numericBranch && numericSymbol) {
			return `${line} <${numericSymbol}>`;
		}
		const symbolicBranch = /\b(?:call|j[a-z]+)\s+(\S+)$/i.exec(line);
		const address = symbolicBranch
			? addressBySymbol.get(symbolicBranch[1])
			: undefined;
		return symbolicBranch && address
			? line.replace(
				symbolicBranch[1],
				`${address} <${symbolicBranch[1]}>`,
			)
			: line;
	}).join('\n');
}

export function normalizeDisassemblySourcePaths(output: string): string {
	return output.split(/\r?\n/).map(line => {
		const source = /^([a-z]):[\\/](.*):(\d+)(.*)$/i.exec(line);
		return source
			? `${source[1].toUpperCase()}:/${source[2].replaceAll('\\', '/')}:${source[3]}${source[4]}`
			: line;
	}).join('\n');
}

function canonicalAddress(address: string): string {
	return address.toLowerCase().replace(/^0+/, '') || '0';
}
