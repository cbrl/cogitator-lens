import assert from 'node:assert/strict';
import test from 'node:test';
import { readCodeViewLines, withCodeViewSourceLines } from '../../src/toolchains/msvc/codeview-lines.js';

interface ObjectFunction {
	readonly name: string;
	/** The offset of the function in the code section. */
	readonly value: number;
	readonly lines: readonly (readonly [offset: number, line: number])[];
}

const source = 'C:\\project\\source.cpp';

/**
 * Builds a COFF object with a code section, the function symbols, and a `.debug$S` section that
 * holds one line table for each function, as `/Z7` writes it.
 */
function coffObject(functions: readonly ObjectFunction[], options: { readonly big?: boolean } = {}): Buffer {
	const symbolSize = options.big ? 20 : 18;
	const headerSize = options.big ? 56 : 20;
	const strings: Buffer[] = [];
	let stringsSize = 4;
	const symbolName = (name: string): Buffer => {
		const field = Buffer.alloc(8);
		if (name.length <= 8) {
			field.write(name, 'utf8');
		} else {
			field.writeUInt32LE(stringsSize, 4);
			strings.push(Buffer.from(`${name}\0`, 'utf8'));
			stringsSize += name.length + 1;
		}
		return field;
	};

	const subsection = (kind: number, data: Buffer): Buffer => {
		const header = Buffer.alloc(8);
		header.writeUInt32LE(kind, 0);
		header.writeUInt32LE(data.length, 4);
		return Buffer.concat([header, data, Buffer.alloc((4 - (data.length % 4)) % 4)]);
	};
	const parts: Buffer[] = [Buffer.from([4, 0, 0, 0])];
	const relocations: Buffer[] = [];
	let debugSize = 4;
	functions.forEach((fn, index) => {
		const lines = Buffer.alloc(24 + fn.lines.length * 8);
		lines.writeUInt32LE(fn.lines.at(-1)![0] + 1, 8);
		lines.writeUInt32LE(0, 12);
		lines.writeUInt32LE(fn.lines.length, 16);
		lines.writeUInt32LE(12 + fn.lines.length * 8, 20);
		fn.lines.forEach(([offset, line], entry) => {
			lines.writeUInt32LE(offset, 24 + entry * 8);
			lines.writeUInt32LE((line | 0x80000000) >>> 0, 28 + entry * 8);
		});
		const relocation = Buffer.alloc(10);
		relocation.writeUInt32LE(debugSize + 8, 0);
		relocation.writeUInt32LE(index, 4);
		relocation.writeUInt16LE(0x0b, 8);
		relocations.push(relocation);
		const part = subsection(0xf2, lines);
		parts.push(part);
		debugSize += part.length;
	});
	const fileNames = Buffer.from(`\0${source}\0`, 'utf8');
	const checksum = Buffer.alloc(8);
	checksum.writeUInt32LE(1, 0);
	parts.push(subsection(0xf4, checksum), subsection(0xf3, fileNames));
	const debug = Buffer.concat(parts);

	const sectionTable = headerSize;
	const debugData = sectionTable + 2 * 40;
	const relocationData = debugData + debug.length;
	const symbolTable = relocationData + relocations.length * 10;
	const section = (name: string, size: number, data: number, relocationStart: number, count: number): Buffer => {
		const header = Buffer.alloc(40);
		header.write(name, 'latin1');
		header.writeUInt32LE(size, 16);
		header.writeUInt32LE(data, 20);
		header.writeUInt32LE(relocationStart, 24);
		header.writeUInt16LE(count, 32);
		return header;
	};
	const symbols = functions.map((fn) => {
		const record = Buffer.alloc(symbolSize);
		symbolName(fn.name).copy(record, 0);
		record.writeUInt32LE(fn.value, 8);
		if (options.big) {
			record.writeInt32LE(1, 12);
			record.writeUInt16LE(0x20, 16);
			record.writeUInt8(2, 18);
		} else {
			record.writeInt16LE(1, 12);
			record.writeUInt16LE(0x20, 14);
			record.writeUInt8(2, 16);
		}
		return record;
	});
	const stringTable = Buffer.concat([Buffer.alloc(4), ...strings]);
	stringTable.writeUInt32LE(stringsSize, 0);

	const header = Buffer.alloc(headerSize);
	if (options.big) {
		header.writeUInt16LE(0xffff, 2);
		header.writeUInt16LE(2, 4);
		header.writeUInt16LE(0x8664, 6);
		Buffer.from('c7a1bad1eebaa94baf20faf66aa4dcb8', 'hex').copy(header, 12);
		header.writeUInt32LE(2, 44);
		header.writeUInt32LE(symbolTable, 48);
		header.writeUInt32LE(symbols.length, 52);
	} else {
		header.writeUInt16LE(0x8664, 0);
		header.writeUInt16LE(2, 2);
		header.writeUInt32LE(symbolTable, 8);
		header.writeUInt32LE(symbols.length, 12);
	}
	return Buffer.concat([
		header,
		section('.text$mn', 0, 0, 0, 0),
		section('.debug$S', debug.length, debugData, relocationData, relocations.length),
		debug,
		...relocations,
		...symbols,
		stringTable,
	]);
}

const functions: readonly ObjectFunction[] = [
	{
		name: '?helper@@YAHH@Z',
		value: 0,
		lines: [
			[0, 1],
			[4, 2],
			[10, 3],
		],
	},
	// A short name is stored in its symbol record, not in the string table.
	{
		name: 'entry',
		value: 0x20,
		lines: [
			[0, 5],
			[8, 0xfeefee],
			[19, 7],
		],
	},
];

test('CodeView line tables give the source line at each section offset of a function', () => {
	const expected = new Map([
		[
			'?helper@@YAHH@Z',
			[
				{ offset: 0, file: source, line: 1 },
				{ offset: 4, file: source, line: 2 },
				{ offset: 10, file: source, line: 3 },
			],
		],
		// The offsets count from the section, and the hidden line of compiler-generated code is left out.
		[
			'entry',
			[
				{ offset: 0x20, file: source, line: 5 },
				{ offset: 0x33, file: source, line: 7 },
			],
		],
	]);
	assert.deepEqual(readCodeViewLines(coffObject(functions)), expected);
	assert.deepEqual(readCodeViewLines(coffObject(functions, { big: true })), expected);
});

test('an object without CodeView lines or with a damaged table gives an empty table', () => {
	assert.equal(readCodeViewLines(Buffer.alloc(0)).size, 0);
	assert.equal(readCodeViewLines(Buffer.from('not an object file at all')).size, 0);
	const object = coffObject(functions);
	assert.equal(readCodeViewLines(object.subarray(0, object.length - 40)).size, 0);
});

test('CodeView lines go before the first instruction of each source line in objdump-shaped output', () => {
	const table = readCodeViewLines(coffObject(functions));
	const listing = [
		'0000000000000000 <?helper@@YAHH@Z>:',
		'       0: 89 4c 24 08                   movl    %ecx, 0x8(%rsp)',
		'       4: 8b 44 24 08                   movl    0x8(%rsp), %eax',
		'       8: d1 e0                         shll    %eax',
		'       a: c3                            retq',
		'0000000000000020 <entry>:',
		'      20: 89 4c 24 08                   movl    %ecx, 0x8(%rsp)',
		'      28: e8 00 00 00 00                callq   0x2d <entry+0xd>',
		'      33: c3                            retq',
		'0000000000000040 <unlisted>:',
		'      40: c3                            retq',
	].join('\n');
	assert.deepEqual(withCodeViewSourceLines(listing, table).split('\n'), [
		'0000000000000000 <?helper@@YAHH@Z>:',
		'C:/project/source.cpp:1',
		'       0: 89 4c 24 08                   movl    %ecx, 0x8(%rsp)',
		'C:/project/source.cpp:2',
		'       4: 8b 44 24 08                   movl    0x8(%rsp), %eax',
		'       8: d1 e0                         shll    %eax',
		'C:/project/source.cpp:3',
		'       a: c3                            retq',
		'0000000000000020 <entry>:',
		'C:/project/source.cpp:5',
		'      20: 89 4c 24 08                   movl    %ecx, 0x8(%rsp)',
		'      28: e8 00 00 00 00                callq   0x2d <entry+0xd>',
		'C:/project/source.cpp:7',
		'      33: c3                            retq',
		'0000000000000040 <unlisted>:',
		'      40: c3                            retq',
	]);
	assert.equal(withCodeViewSourceLines(listing, new Map()), listing);
});
