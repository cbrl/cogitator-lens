import { normalizeDisassemblySourcePaths } from '../../artifacts/binary-disassembly/binary-disassembly-producer.js';

/** A source line that starts at an offset in the section of its function. */
export interface CodeViewLine {
	readonly offset: number;
	readonly file: string;
	readonly line: number;
}

/** The source lines of each function in an object file, by the name of its symbol. */
export type CodeViewLineTable = ReadonlyMap<string, readonly CodeViewLine[]>;

const debugSymbolsSection = '.debug$S';
const codeViewSignature = 4;
const linesSubsection = 0xf2;
const stringsSubsection = 0xf3;
const fileChecksumsSubsection = 0xf4;
const ignoredSubsection = 0x80000000;
/** Line numbers from this value up, such as 0xfeefee, mark compiler-generated code. */
const firstSpecialLine = 0xf00000;
/** The section stores its relocation count in its first relocation. */
const relocationOverflow = 0x01000000;
const bigObjectClassId = Buffer.from('c7a1bad1eebaa94baf20faf66aa4dcb8', 'hex');

interface CoffLayout {
	readonly sectionTable: number;
	readonly sectionCount: number;
	readonly symbolTable: number;
	readonly symbolCount: number;
	readonly symbolSize: number;
}

interface CoffSymbol {
	readonly name: string;
	/** The offset of the symbol in its section. */
	readonly value: number;
}

interface PendingLine {
	readonly offset: number;
	readonly fileId: number;
	readonly line: number;
}

/**
 * Reads the CodeView line tables of a COFF object, which `/Z7` writes. dumpbin prints no line
 * numbers for an object, and llvm-objdump reads only DWARF line tables. Malformed or other input
 * gives an empty table.
 */
export function readCodeViewLines(object: Buffer): CodeViewLineTable {
	try {
		return readLineTable(object);
	} catch (error) {
		if (error instanceof RangeError) {
			return new Map();
		}
		throw error;
	}
}

function readLineTable(object: Buffer): CodeViewLineTable {
	const layout = coffLayout(object);
	if (!layout) {
		return new Map();
	}
	const symbols = readSymbols(object, layout);
	const pending = new Map<string, PendingLine[]>();
	let strings: Buffer | undefined;
	let checksums: Buffer | undefined;
	for (let index = 0; index < layout.sectionCount; index++) {
		const header = layout.sectionTable + index * 40;
		if (object.toString('latin1', header, header + 8).replace(/\0+$/u, '') !== debugSymbolsSection) {
			continue;
		}
		const start = object.readUInt32LE(header + 20);
		const data = object.subarray(start, start + object.readUInt32LE(header + 16));
		if (data.length < 4 || data.readUInt32LE(0) !== codeViewSignature) {
			continue;
		}
		const relocations = readRelocations(object, header);
		let position = 4;
		while (position + 8 <= data.length) {
			const kind = data.readUInt32LE(position);
			const subsection = data.subarray(position + 8, position + 8 + data.readUInt32LE(position + 4));
			if ((kind & ignoredSubsection) === 0) {
				if (kind === linesSubsection) {
					// cl.exe and clang-cl relocate the start of the table to the symbol of its function.
					const symbol = symbols.get(relocations.get(position + 8) ?? -1);
					if (symbol) {
						const lines = pending.get(symbol.name) ?? [];
						pending.set(symbol.name, lines);
						readLineBlocks(subsection, symbol.value + subsection.readUInt32LE(0), lines);
					}
				} else if (kind === stringsSubsection) {
					strings ??= subsection;
				} else if (kind === fileChecksumsSubsection) {
					checksums ??= subsection;
				}
			}
			position = (position + 8 + subsection.length + 3) & ~3;
		}
	}

	const table = new Map<string, CodeViewLine[]>();
	if (!strings || !checksums) {
		return table;
	}
	const fileStrings = strings;
	const fileChecksums = checksums;
	const files = new Map<number, string>();
	const fileName = (fileId: number): string => {
		let file = files.get(fileId);
		if (file === undefined) {
			file = nullTerminated(fileStrings, fileChecksums.readUInt32LE(fileId), 'utf8');
			files.set(fileId, file);
		}
		return file;
	};
	for (const [name, lines] of pending) {
		table.set(
			name,
			lines
				.map((line) => ({ offset: line.offset, file: fileName(line.fileId), line: line.line }))
				.sort((left, right) => left.offset - right.offset),
		);
	}
	return table;
}

/** Reads the header of a regular or a `/bigobj` COFF object. */
function coffLayout(object: Buffer): CoffLayout | undefined {
	if (object.length < 20) {
		return undefined;
	}
	if (object.readUInt16LE(0) === 0 && object.readUInt16LE(2) === 0xffff) {
		// An import library member and a `/GL` object have this signature too, and contain no code.
		if (object.length < 56 || object.readUInt16LE(4) < 2 || !object.subarray(12, 28).equals(bigObjectClassId)) {
			return undefined;
		}
		return {
			sectionTable: 56,
			sectionCount: object.readUInt32LE(44),
			symbolTable: object.readUInt32LE(48),
			symbolCount: object.readUInt32LE(52),
			symbolSize: 20,
		};
	}
	return {
		sectionTable: 20 + object.readUInt16LE(16),
		sectionCount: object.readUInt16LE(2),
		symbolTable: object.readUInt32LE(8),
		symbolCount: object.readUInt32LE(12),
		symbolSize: 18,
	};
}

/** Reads the symbol table by the index of each symbol. Auxiliary records have no entry. */
function readSymbols(object: Buffer, layout: CoffLayout): Map<number, CoffSymbol> {
	const stringTable = layout.symbolTable + layout.symbolCount * layout.symbolSize;
	const auxiliaryCount = layout.symbolSize === 20 ? 19 : 17;
	const symbols = new Map<number, CoffSymbol>();
	let index = 0;
	while (index < layout.symbolCount) {
		const record = layout.symbolTable + index * layout.symbolSize;
		symbols.set(index, {
			name:
				object.readUInt32LE(record) === 0
					? nullTerminated(object, stringTable + object.readUInt32LE(record + 4), 'utf8')
					: object.toString('utf8', record, record + 8).replace(/\0.*$/su, ''),
			value: object.readUInt32LE(record + 8),
		});
		index += 1 + object.readUInt8(record + auxiliaryCount);
	}
	return symbols;
}

/** Maps the offset of each relocation in a section to the index of its symbol. */
function readRelocations(object: Buffer, sectionHeader: number): Map<number, number> {
	const start = object.readUInt32LE(sectionHeader + 24);
	let count = object.readUInt16LE(sectionHeader + 32);
	let first = 0;
	if ((object.readUInt32LE(sectionHeader + 36) & relocationOverflow) !== 0 && count === 0xffff) {
		count = object.readUInt32LE(start);
		first = 1;
	}
	const relocations = new Map<number, number>();
	for (let index = first; index < count; index++) {
		const relocation = start + index * 10;
		relocations.set(object.readUInt32LE(relocation), object.readUInt32LE(relocation + 4));
	}
	return relocations;
}

/** Reads the file blocks of a lines subsection, after its 12-byte header. */
function readLineBlocks(subsection: Buffer, base: number, lines: PendingLine[]): void {
	let block = 12;
	while (block + 12 <= subsection.length) {
		const fileId = subsection.readUInt32LE(block);
		const count = subsection.readUInt32LE(block + 4);
		const size = subsection.readUInt32LE(block + 8);
		for (let index = 0; index < count; index++) {
			const entry = block + 12 + index * 8;
			const line = subsection.readUInt32LE(entry + 4) & 0xffffff;
			if (line > 0 && line < firstSpecialLine) {
				lines.push({ offset: base + subsection.readUInt32LE(entry), fileId, line });
			}
		}
		if (size < 12) {
			return;
		}
		block += size;
	}
}

function nullTerminated(buffer: Buffer, start: number, encoding: BufferEncoding): string {
	if (start < 0 || start >= buffer.length) {
		throw new RangeError(`String offset ${start} is outside its table`);
	}
	const end = buffer.indexOf(0, start);
	return buffer.toString(encoding, start, end < 0 ? buffer.length : end);
}

/** A function header and an instruction address in objdump-shaped output. */
const functionHeader = /^([\da-f]+) <(.+)>:$/;
const instructionAddress = /^\s*([\da-f]+):\s/;

/**
 * Adds a `file:line` marker before each instruction that starts a new source line, in the form
 * that GNU objdump writes with `-l`. The addresses in a disassembled object count from the start
 * of each section, as the offsets in the line table do.
 */
export function withCodeViewSourceLines(disassembly: string, table: CodeViewLineTable): string {
	if (table.size === 0) {
		return disassembly;
	}
	const output: string[] = [];
	let lines: readonly CodeViewLine[] = [];
	let next = 0;
	let current: CodeViewLine | undefined;
	for (const text of disassembly.split('\n')) {
		const header = functionHeader.exec(text.trimEnd());
		const instruction = header ? undefined : instructionAddress.exec(text);
		if (header) {
			lines = table.get(header[2]) ?? [];
			next = 0;
			current = undefined;
		} else if (instruction) {
			const address = Number.parseInt(instruction[1], 16);
			let found = current;
			while (next < lines.length && lines[next].offset <= address) {
				found = lines[next++];
			}
			if (found && (found.file !== current?.file || found.line !== current.line)) {
				output.push(normalizeDisassemblySourcePaths(`${found.file}:${found.line}`));
			}
			current = found;
		}
		output.push(text);
	}
	return output.join('\n');
}
