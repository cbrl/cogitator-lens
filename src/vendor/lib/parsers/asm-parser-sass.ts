// Copyright (c) 2020, Compiler Explorer Authors
// All rights reserved. See THIRD_PARTY_NOTICES.md for the BSD 2-Clause license.

import type { PropertyGetter } from '../properties.interfaces.js';
import { AsmParser } from './asm-parser.js';

/** Compiler Explorer's parser configuration for `nvdisasm` SASS listings. */
export class SassAsmParser extends AsmParser {
	constructor(compilerProps?: PropertyGetter) {
		super(compilerProps);
		this.asmOpcodeRe =
			/^\s*\/\*(?<address>[^*]+)\*\/()()\s*\{?\s*(?<disasm>[^;}]+)(?:\}|;\s*\/\* 0x(?<opcodes>[\da-f]+) \*\/)/u;
		this.lineRe = /^\s*\/\/## File "([^"]+)", line (?<line>\d+)$/u;
		this.labelRe = /^(?!\.text\.)()(\S[^:]+):$/u;
	}
}
