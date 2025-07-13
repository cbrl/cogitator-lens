import { ParsedAsmResult } from './asmresult.interfaces.js';
import { ParseFiltersAndOutputOptions } from './filters.interfaces.js';

export interface IAsmParser {
    process(asm: string, filters: ParseFiltersAndOutputOptions): ParsedAsmResult;
}
