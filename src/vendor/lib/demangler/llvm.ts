import type { ParsedAsmResult } from '../../types/asmresult/asmresult.interfaces.js';

/**
 * Cogitator Lens does not demangle LLVM IR during rendering. This local integration
 * boundary supplies the two methods used by Compiler Explorer's LlvmIrParser while
 * keeping the unrelated Compiler Explorer demangler/execution hierarchy out of the
 * extension bundle.
 */
export class LLVMIRDemangler {
	canDemangle(): boolean {
		return false;
	}

	async process(result: ParsedAsmResult): Promise<ParsedAsmResult> {
		return result;
	}
}
