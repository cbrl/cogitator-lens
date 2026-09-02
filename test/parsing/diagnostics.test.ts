import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import type { Uri } from 'vscode';
import {
	composeDiagnosticParsers,
} from '../../src/diagnostics.js';
import { parseGnuDiagnostics } from '../../src/toolchains/c-family/diagnostics.js';
import { parseGoDiagnostics } from '../../src/toolchains/go/diagnostics.js';
import { parseParenthesizedDiagnostics } from '../../src/toolchains/msvc/diagnostics.js';
import { parsePythonDiagnostics } from '../../src/toolchains/python/diagnostics.js';
import { parseRustDiagnostics } from '../../src/toolchains/rust/diagnostics.js';
import { toolchainDefinitions } from '../../src/toolchains/toolchain-map.js';

const workingDirectory = path.resolve('diagnostic-fixtures', 'build');
const fallback = fakeUri(path.resolve('diagnostic-fixtures', 'source.cpp'));

function fakeUri(fsPath: string): Uri {
	return {
		fsPath,
		toString: () => `file://${fsPath.replaceAll('\\', '/')}`,
		with: (changes: { path?: string }) => fakeUri(changes.path ?? fsPath),
	} as Uri;
}

test('GNU diagnostics support Windows paths and optional columns', () => {
	const diagnostics = parseGnuDiagnostics(
		'C:\\project\\main.cpp:4:7: error: broken\n../main.cpp:8: warning: suspicious',
		fallback,
		workingDirectory,
	);
	assert.deepEqual(
		diagnostics.map(({ line, column, severity, message }) => ({ line, column, severity, message })),
		[
			{ line: 3, column: 6, severity: 'error', message: 'broken' },
			{ line: 7, column: 0, severity: 'warning', message: 'suspicious' },
		],
	);
});

test('parenthesized diagnostics support MSVC codes, .NET ranges, and CUDA records', () => {
	const diagnostics = parseParenthesizedDiagnostics(
		[
			'C:\\project\\main.cpp(8,3): warning C4100: unreferenced parameter',
			'Program.cs(12,5,12,9): error CS1002: ; expected',
			'kernel.cu(21): error: device failure',
		].join('\n'),
		fallback,
		workingDirectory,
	);
	assert.deepEqual(
		diagnostics.map(({ line, column, severity, message }) => ({ line, column, severity, message })),
		[
			{ line: 7, column: 2, severity: 'warning', message: 'C4100: unreferenced parameter' },
			{ line: 11, column: 4, severity: 'error', message: 'CS1002: ; expected' },
			{ line: 20, column: 0, severity: 'error', message: 'device failure' },
		],
	);
});

test('Rust, Python, and Go parsers preserve their family-specific state and gutters', () => {
	const rust = parseRustDiagnostics(
		'error[E0308]: mismatched types\n  --> src/main.rs:5:9\nwarning: unused value\n --> src/main.rs:8:2',
		fallback,
		workingDirectory,
	);
	assert.deepEqual(
		rust.map(({ line, column, severity, message }) => ({ line, column, severity, message })),
		[
			{ line: 4, column: 8, severity: 'error', message: '[E0308] mismatched types' },
			{ line: 7, column: 1, severity: 'warning', message: 'unused value' },
		],
	);

	const python = parsePythonDiagnostics(
		'  File "source.py", line 3\n    value =\n           ^\nSyntaxError: invalid syntax',
		fallback,
		workingDirectory,
	);
	assert.equal(python[0].column, 7);

	const go = parseGoDiagnostics(
		'cmd/main.go:9:4: undefined: value\ncmd/main.go:11: another error',
		fallback,
		workingDirectory,
	);
	assert.deepEqual(
		go.map(({ line, column }) => ({ line, column })),
		[
			{ line: 8, column: 3 },
			{ line: 10, column: 0 },
		],
	);
});

test('composed parsers deduplicate records and toolchains select only intended families', () => {
	const duplicate = 'main.cpp:2:3: error: duplicate';
	assert.equal(
		composeDiagnosticParsers(parseGnuDiagnostics, parseGnuDiagnostics)(duplicate, fallback, workingDirectory)
			.length,
		1,
	);
	assert.equal(
		toolchainDefinitions.gcc.parseDiagnostics('main.go:2:3: missing', fallback, workingDirectory).length,
		0,
	);
	assert.equal(
		toolchainDefinitions.go.parseDiagnostics('main.go:2:3: missing', fallback, workingDirectory).length,
		1,
	);
	assert.equal(
		toolchainDefinitions['clang-cl'].parseDiagnostics('main.cpp(2): error C1: bad', fallback, workingDirectory)
			.length,
		1,
	);
	assert.equal(
		toolchainDefinitions.nvcc.parseDiagnostics('kernel.cu(2): error: bad', fallback, workingDirectory).length,
		1,
	);
});
