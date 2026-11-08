/** One section of an object file and its size in bytes. */
export interface ObjectSection {
	readonly name: string;
	readonly size: number;
}

/** A row of `objdump -h` or `llvm-objdump -h`: index, name, size, and then the address. */
const objdumpSection = /^\s*\d+\s+(\S+)\s+([0-9a-fA-F]+)\s+[0-9a-fA-F]+/u;

/**
 * Reads the section headers of GNU objdump and llvm-objdump. The empty first section of an ELF file
 * has no name in llvm-objdump output, so its row does not match.
 */
export function parseObjdumpSections(output: string): readonly ObjectSection[] {
	return output.split(/\r?\n/u).flatMap((line) => {
		const match = objdumpSection.exec(line);
		return match ? [{ name: match[1], size: Number.parseInt(match[2], 16) }] : [];
	});
}

/** Reads the section headers of `dumpbin /HEADERS`: a name line, then a size line, in each header. */
export function parseDumpbinSections(output: string): readonly ObjectSection[] {
	const sections: ObjectSection[] = [];
	let name: string | undefined;
	for (const line of output.split(/\r?\n/u)) {
		if (/^SECTION HEADER #\d+/u.test(line)) {
			name = undefined;
			continue;
		}
		const nameLine = /^\s*(\S+) name$/u.exec(line);
		if (nameLine) {
			name = nameLine[1];
			continue;
		}
		const sizeLine = /^\s*([0-9A-Fa-f]+) size of raw data$/u.exec(line);
		if (sizeLine && name !== undefined) {
			sections.push({ name, size: Number.parseInt(sizeLine[1], 16) });
			name = undefined;
		}
	}
	return sections;
}

/** Sections that hold debug information, symbols, relocations, or linker data, not code or data. */
const metadataSection =
	/^(?:\.debug|__debug|\.rela?(?:\.|$)|\.rel\.|\.symtab|\.strtab|\.shstrtab|\.comment|\.note|\.group|\.drectve|\.llvm_addrsig|\.llvm\.|\.cv_|__LD|__compact_unwind)/u;

/**
 * The sections of the linked image: the linker merges `.text$mn` into `.text` and merges sections
 * with the same name, such as the one section of each function. Debug, symbol, relocation, and
 * linker sections and empty sections are left out. The largest section comes first.
 */
export function imageSections(sections: readonly ObjectSection[]): readonly ObjectSection[] {
	const sizes = new Map<string, number>();
	for (const section of sections) {
		const name = section.name.replace(/\$.*$/u, '');
		if (!metadataSection.test(name)) {
			sizes.set(name, (sizes.get(name) ?? 0) + section.size);
		}
	}
	return [...sizes]
		.filter(([, size]) => size > 0)
		.map(([name, size]) => ({ name, size }))
		.sort((left, right) => right.size - left.size || left.name.localeCompare(right.name));
}
