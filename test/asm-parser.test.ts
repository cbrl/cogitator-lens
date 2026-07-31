import assert from 'node:assert/strict';
import test from 'node:test';
import { AsmParser } from '../src/vendor/lib/parsers/asm-parser.js';
import { VcAsmParser } from '../src/vendor/lib/parsers/asm-parser-vc.js';
import { noopPropertyGetter } from '../src/vendor/compiler-props.js';

const filters = {
	labels: false,
	directives: false,
	commentOnly: false,
	libraryCode: false,
	dontMaskFilenames: true,
};

test('parses supported assembly dialects with source mappings', () => {
	const fixtures = [
		{
			name: 'GNU',
			parser: new AsmParser(noopPropertyGetter),
			opcode: 'movl',
			sourceLine: 2,
			text: [
				'.file 1 "/project/path with spaces/ü" "main.cpp"',
				'.text',
				'.loc 1 2 5',
				'main:',
				'  movl $1, %eax',
				'  ret',
			].join('\n'),
		},
		{
			name: 'MSVC',
			parser: new VcAsmParser(noopPropertyGetter),
			opcode: 'mov eax',
			sourceLine: 3,
			text: [
				'; Function compile flags: /O2',
				'_TEXT SEGMENT',
				'?main@@YAHXZ PROC',
				'; File C:\\project path\\main.cpp',
				'; Line 3',
				'  mov eax, 1',
				'  ret 0',
				'?main@@YAHXZ ENDP',
				'_TEXT ENDS',
				'END',
			].join('\n'),
		},
		{
			name: 'Rust CodeView',
			parser: new AsmParser(noopPropertyGetter),
			opcode: 'imul',
			sourceLine: 3,
			text: [
				'.file "rust_fixture"',
				'.section .text',
				'.globl square',
				'square:',
				'.cv_func_id 0',
				'.cv_file 1 "C:\\project path\\source.rs"',
				'.cv_loc 0 1 3 0',
				'  imul eax, ecx',
				'  ret',
			].join('\n'),
		},
	];

	for (const fixture of fixtures) {
		const result = fixture.parser.process(fixture.text, filters);
		assert.ok(
			result.asm.some(line => line.text.includes(fixture.opcode)),
			`${fixture.name} fixture lost its opcode`,
		);
		assert.ok(
			result.asm.some(line => line.source?.line === fixture.sourceLine),
			`${fixture.name} fixture lost its source mapping`,
		);
	}
});
