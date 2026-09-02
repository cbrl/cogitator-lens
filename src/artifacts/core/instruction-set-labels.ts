/**
 * The name reported for each documentation provider.
 *
 * Kept as a table so callers can name the instruction set they expect without
 * repeating the display text.
 */
export const instructionSetLabels = {
	amd64: 'x86 / AMD64',
	aarch64: 'AArch64',
	arm32: 'ARM32',
	riscv64: 'RISC-V',
	llvmIr: 'LLVM IR',
	dotNetIl: '.NET IL',
	pythonBytecode: 'Python bytecode',
} as const;
