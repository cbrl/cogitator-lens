import assert from 'node:assert/strict';
import test from 'node:test';
import {
	documentationForInstruction,
	instructionMnemonic,
} from '../src/asm-document/instruction-documentation.js';
import type {
	ArtifactKind,
	RenderedArtifactLine,
	RenderedTextArtifact,
} from '../src/types/index.js';

test('Compiler Explorer documentation replaces the hand-written x86 subset', () => {
	const artifact = textArtifact('assembly', [
		{ text: '  push rbp' },
		{ text: '  call helper' },
		{ text: '  vzeroupper' },
	]);
	const documentation = documentationForInstruction(artifact, 'call helper');
	assert.equal(documentation?.instructionSet, 'x86 / AMD64');
	assert.match(documentation?.tooltip ?? '', /procedure/i);
	assert.match(documentation?.url ?? '', /CALL/i);
	assert.ok(documentationForInstruction(artifact, 'vzeroupper')?.tooltip);
});

test('assembly documentation infers AArch64 and RISC-V from a complete listing', () => {
	const aarch64 = textArtifact('assembly', [
		{ text: '  stp x29, x30, [sp, #-16]!' },
		{ text: '  adrp x0, symbol' },
		{ text: '  blr x8' },
	]);
	assert.equal(
		documentationForInstruction(aarch64, aarch64.lines[0].text)?.instructionSet,
		'AArch64',
	);

	const riscv = textArtifact('binary-disassembly', [
		{ text: '0: 13 05 10 00 addi a0, zero, 1', disassembly: 'addi a0, zero, 1' },
		{ text: '4: 67 80 00 00 jalr zero, 0(ra)', disassembly: 'jalr zero, 0(ra)' },
	]);
	assert.equal(
		documentationForInstruction(riscv, riscv.lines[0].disassembly ?? '')?.instructionSet,
		'RISC-V',
	);
});

test('LLVM IR and Python bytecode use their artifact-specific docenized tables', () => {
	const llvm = textArtifact('llvm-ir', [{ text: '  %sum = add i32 %left, %right' }]);
	const llvmDocumentation = documentationForInstruction(llvm, llvm.lines[0].text);
	assert.equal(llvmDocumentation?.mnemonic, 'add');
	assert.equal(llvmDocumentation?.instructionSet, 'LLVM IR');
	assert.match(llvmDocumentation?.url ?? '', /LangRef/);
	assert.equal(instructionMnemonic('llvm-ir', '  tail call void @work()'), 'call');

	const python = textArtifact('python-bytecode', [{ text: '  4          10 BINARY_OP                0 (+)' }]);
	const pythonDocumentation = documentationForInstruction(python, python.lines[0].text);
	assert.equal(pythonDocumentation?.mnemonic, 'binary_op');
	assert.equal(pythonDocumentation?.instructionSet, 'Python bytecode');
	assert.match(pythonDocumentation?.url ?? '', /python\.org/);
});

function textArtifact(
	kind: ArtifactKind,
	lines: readonly RenderedArtifactLine[],
): RenderedTextArtifact {
	return {
		kind,
		presentation: 'text',
		diagnostics: [],
		durationMs: 0,
		generatedAt: 0,
		command: {
			executable: '',
			args: [],
			environmentVariableNames: [],
			cwd: '',
		},
		metrics: {},
		truncated: false,
		toolOutputTruncated: false,
		lines,
		sourceLocations: [],
		links: [],
		folds: [],
		symbols: [],
		raw: lines.map(line => line.text).join('\n'),
		text: lines.map(line => line.text).join('\n'),
	};
}
