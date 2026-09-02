import assert from 'node:assert/strict';
import test from 'node:test';
import {
	classifyArtifactLine,
	listingSyntaxes,
	type LineToken,
} from '../src/artifacts/core/listing-syntax.js';

const documentedOpcodes = new Set(['push', 'callvirt', 'binary_op', 'add', 'call']);
const context = { isDocumentedOpcode: (candidate: string) => documentedOpcodes.has(candidate.toLowerCase()) };

function hasToken(tokens: readonly LineToken[], type: LineToken['type'], start: number, length: number): boolean {
	return tokens.some((token) => token.type === type && token.start === start && token.length === length);
}

test('listing syntaxes classify representative instruction lines', () => {
	const native = classifyArtifactLine('  push rbp', listingSyntaxes['native-assembly'], context);
	assert.ok(hasToken(native, 'keyword', 2, 4));
	assert.ok(hasToken(native, 'variable', 7, 3));

	const dotnet = classifyArtifactLine(
		'IL_0000: callvirt instance void Demo::Run()',
		listingSyntaxes['dotnet-il'],
		context,
	);
	assert.ok(hasToken(dotnet, 'label', 0, 7));
	assert.ok(hasToken(dotnet, 'keyword', 9, 8));

	const python = classifyArtifactLine('  4  10 BINARY_OP  0 (+)', listingSyntaxes['python-bytecode'], context);
	assert.ok(hasToken(python, 'keyword', 8, 9));

	const llvm = classifyArtifactLine('%sum = add i32 %left, %right', listingSyntaxes['llvm-ir'], context);
	assert.ok(hasToken(llvm, 'keyword', 7, 3));
	assert.ok(hasToken(llvm, 'type', 11, 3));
});

test('a trailing comment wins priority over opcode candidates inside it', () => {
	const text = '%sum = add i32 1, 2 ; call void @work()';
	const tokens = classifyArtifactLine(text, listingSyntaxes['llvm-ir'], context);
	const commentStart = text.indexOf(';');
	assert.ok(hasToken(tokens, 'comment', commentStart, text.length - commentStart));
	assert.equal(
		tokens.some((token) => token.type === 'keyword' && token.start > commentStart),
		false,
	);
});
