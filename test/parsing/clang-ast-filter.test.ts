import assert from 'node:assert/strict';
import test from 'node:test';
import { systemDeclarationFilter } from '../../src/artifacts/ast/clang-system-declarations.js';

const dump = [
	'TranslationUnitDecl 0x1 <<invalid sloc>> <invalid sloc>',
	"|-TypedefDecl 0x2 <<invalid sloc>> <invalid sloc> implicit __int128_t '__int128'",
	"| `-BuiltinType 0x3 '__int128'",
	'|-NamespaceDecl 0x4 </usr/include/c++/13/bits/c++config.h:308:1, line:340:1> line:308:11 std',
	'| `-FunctionDecl 0x5 <line:320:3, col:30> col:8 swap',
	// Relative to the last printed file, which is still the system header.
	"|-TypedefDecl 0x6 <line:345:1, col:20> col:20 size_t 'unsigned long'",
	"|-FunctionDecl 0x7 </project/main.cpp:3:1, line:5:1> line:3:5 square 'int (int)'",
	"| `-ParmVarDecl 0x8 <col:12, col:16> col:16 value 'int'",
	// Relative to the compiled file now.
	"`-VarDecl 0x9 <line:7:1, col:13> col:5 answer 'int'",
	"  `-IntegerLiteral 0xa <col:13> 'int' 42",
];

test('the AST filter drops system and compiler declarations as Clang prints them', () => {
	const keep = systemDeclarationFilter('/project/main.cpp', '/project');
	assert.deepEqual(
		dump.filter((line) => keep(line)).map((line) => line.split(' ')[0]),
		['TranslationUnitDecl', '|-FunctionDecl', '|', '`-VarDecl', ''],
	);
});
