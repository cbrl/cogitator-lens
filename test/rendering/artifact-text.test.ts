import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { artifactDefinitions } from '../../src/artifacts/core/artifact-definitions.js';
import { defaultArtifactOptions, type RawArtifact } from '../../src/types/index.js';
import { rawArtifact, renderContext } from '../support/artifacts.js';
import { readFixture } from '../support/environment.js';

const display = defaultArtifactOptions.display;
const render = artifactDefinitions;

test('preprocessed source follows line markers and drops included files on request', () => {
	const source = path.resolve('/project/source.cpp');
	const header = path.resolve('/project/header.h');
	const raw = rawArtifact(
		'preprocessed-source',
		[
			`# 1 "${source}"`,
			'int own;',
			`# 7 "${header}" 1`,
			'int included;',
			`#line 2 "${source}"`,
			'int own_again;',
		].join('\n'),
	);
	const context = renderContext('gcc', { file: source });

	const shown = render['preprocessed-source'].renderer(raw, display, context);
	assert.equal(shown.lines.find((line) => line.text === 'int included;')?.source?.line, 7);
	assert.equal(shown.metrics.includedFileCount, 1);

	const hidden = render['preprocessed-source'].renderer(raw, { ...display, showIncludedFiles: false }, context);
	assert.ok(!hidden.lines.some((line) => line.text === 'int included;'));
	assert.equal(hidden.lines.find((line) => line.text === 'int own_again;')?.source?.line, 2);
});

test('Clang AST rendering removes addresses, filters system subtrees, and adds symbols', () => {
	const source = path.resolve('/project/source.cpp');
	const rendered = render.ast.renderer(
		rawArtifact(
			'ast',
			[
				'TranslationUnitDecl 0x1234 <<invalid sloc>>',
				`|-FunctionDecl 0xABCD <${source}:1:1, line:3:1> line:1:5 main 'int ()'`,
				'| `-CompoundStmt 0x00ff <col:12, line:3:1>',
				"`-FunctionDecl 0x9999 </usr/include/stdio.h:2:1, col:10> system_fn 'void ()'",
				'  `-CompoundStmt 0x8888 <col:11, col:12>',
			].join('\n'),
		),
		display,
		renderContext('clang', { file: source }),
	);

	assert.ok(!rendered.lines.some((line) => /0x[0-9a-f]/i.test(line.text)));
	assert.ok(!rendered.lines.some((line) => line.text.includes('system_fn')));
	assert.deepEqual(rendered.symbols, [{ name: 'main', line: 1 }]);
	assert.deepEqual(rendered.lines[1].source, {
		file: source,
		line: 1,
		column: 0,
		endLine: 3,
		endColumn: 1,
		mainSource: true,
	});
});

test('Python AST rendering maps folds, symbols, and UTF-8 offsets to editor columns', () => {
	const source = path.resolve('/project/source.py');
	const rendered = render.ast.renderer(
		rawArtifact(
			'ast',
			[
				'Module(',
				'  body=[',
				'    FunctionDef(',
				"      name='answer',",
				'      body=[],',
				'      decorator_list=[],',
				'      lineno=4,',
				'      col_offset=2,',
				'      end_lineno=4,',
				'      end_col_offset=14)],',
				'  type_ignores=[])',
			].join('\n'),
		),
		display,
		renderContext('python', { file: source, text: 'first\nsecond\nthird\n  def answer()' }),
	);
	assert.deepEqual(rendered.symbols, [{ name: 'answer', line: 2 }]);
	assert.deepEqual(rendered.lines[2].source, {
		file: source,
		line: 4,
		column: 2,
		endLine: 4,
		endColumn: 14,
		mainSource: true,
	});
	assert.ok(rendered.folds.some((fold) => fold.startLine === 2));

	// A multi-byte character before the node shifts the UTF-8 offset the compiler
	// reports away from the editor column.
	const unicode = render.ast.renderer(
		rawArtifact(
			'ast',
			[
				'Name(',
				"  id='value',",
				'  ctx=Load(),',
				'  lineno=1,',
				'  col_offset=5,',
				'  end_lineno=1,',
				'  end_col_offset=10)',
			].join('\n'),
		),
		display,
		renderContext('python', { file: path.resolve('/project/unicode.py'), text: 'é = value' }),
	);
	assert.deepEqual(unicode.lines[0].source, {
		file: path.resolve('/project/unicode.py'),
		line: 1,
		column: 4,
		endLine: 1,
		endColumn: 9,
		mainSource: true,
	});
});

test('Rust MIR rendering exposes symbols, block metrics, goto links, and function folds', () => {
	const rendered = render['rust-mir'].renderer(
		rawArtifact(
			'rust-mir',
			[
				'fn choose(_1: bool) -> i32 {',
				'    bb0: {',
				'        switchInt(copy _1) -> [0: bb2, otherwise: bb1];',
				'    }',
				'    bb1: {',
				'        return;',
				'    }',
				'    bb2: {',
				'        goto -> bb1;',
				'    }',
				'}',
			].join('\n'),
		),
		display,
		renderContext('rust', { file: path.resolve('/project/source.rs') }),
	);

	assert.deepEqual(rendered.symbols, [{ name: 'choose', line: 0 }]);
	assert.equal(rendered.metrics.basicBlockCount, 3);
	assert.ok(rendered.links.some((link) => link.line === 2 && link.targetLine === 4));
	assert.ok(rendered.folds.some((fold) => fold.startLine === 0 && fold.endLine === 10));
});

test('LLVM IR rendering resolves debug metadata into source links and function navigation', async () => {
	// Debug metadata names a relative file, resolved against the compilation directory.
	const rendered = await render['llvm-ir'].renderer(
		compiledIn('/work', rawArtifact('llvm-ir', readFixture('llvm-ir', 'debug.ll'))),
		display,
		renderContext('clang'),
	);

	assert.deepEqual(rendered.lines.find((line) => line.text.includes('%mul ='))?.source, {
		file: path.resolve('/work/source.cpp'),
		line: 4,
		column: 11,
	});
	assert.ok(rendered.sourceLocations.some((location) => location.sourceLine === 4));
	assert.deepEqual(rendered.symbols, [{ name: 'square', line: 3 }]);
	assert.deepEqual(rendered.folds, [{ startLine: 3, endLine: 7 }]);
	assert.equal(rendered.metrics.functionCount, 1);
});

test('Python bytecode rendering maps both supported disassembly layouts to source lines', () => {
	const source = 'C:\\project\\main.py';
	const context = renderContext('python', { file: source, text: 'def add(a, b):\n    return a + b\n' });
	const bytecode = (text: string) =>
		render['python-bytecode'].renderer(
			rawArtifact('python-bytecode', text, {
				command: {
					executable: process.execPath,
					arguments: ['-m', 'dis', source],
					environmentVariableNames: [],
					workingDirectory: 'C:\\project',
				},
			}),
			display,
			context,
		);

	const nested = bytecode(
		[
			'  0           RESUME                   0',
			'',
			'  1           LOAD_CONST               0 (<code object add>)',
			'              MAKE_FUNCTION',
			'              STORE_NAME               0 (add)',
			'',
			'Disassembly of <code object add at 0x1, file "main.py", line 1>:',
			'  2           LOAD_FAST_LOAD_FAST      1 (a, b)',
			'              BINARY_OP                0 (+)',
			'',
			'  3           RETURN_VALUE',
		].join('\n'),
	);
	const mapped = nested.lines.filter((line) => line.source);
	assert.deepEqual([...new Set(mapped.map((line) => line.source?.line))], [1, 2, 3]);
	assert.ok(mapped.every((line) => line.source?.file === source && line.source.mainSource));
	assert.deepEqual(
		[nested.metrics.instructionCount, nested.metrics.codeObjectCount, nested.metrics.sourceLineCount],
		[7, 2, 3],
	);

	const offsetBearing = bytecode(
		[
			'  1           0 LOAD_CONST               0 (1)',
			'              2 STORE_NAME               0 (value)',
			'              4 RETURN_VALUE',
		].join('\n'),
	);
	assert.ok(offsetBearing.lines.every((line) => line.source?.line === 1));
	assert.equal(offsetBearing.metrics.instructionCount, 3);
});

test('.NET IL rendering exposes method-scoped labels, symbols, folds, and code metrics', () => {
	const il = [
		'.method public hidebysig static int32 First() cil managed',
		'{',
		'  // Code size 4 (0x4)',
		'  IL_0000: ldc.i4.1',
		'  IL_0001: br.s IL_0003',
		'  IL_0003: ret',
		'} // end of method Demo::First',
		'.method public hidebysig static int32 Second() cil managed',
		'{',
		'  // Code size 4 (0x4)',
		'  IL_0000: ldc.i4.2',
		'  IL_0001: br.s IL_0003',
		'  IL_0003: ret',
		'} // end of method Demo::Second',
	].join('\n');
	const rendered = render['dotnet-il'].renderer(
		rawArtifact('dotnet-il', il, {
			dotnetSourceMapping: [
				{
					method: {
						typeName: 'Demo',
						typeArguments: [],
						methodName: 'First',
						methodArguments: [],
						parameters: [],
						returnType: 'int',
					},
					offsets: { 0: { file: null, line: 3, column: 2 }, 3: null },
				},
				{
					method: {
						typeName: 'Demo',
						typeArguments: [],
						methodName: 'Second',
						methodArguments: [],
						parameters: [],
						returnType: 'int',
					},
					offsets: { 0: { file: null, line: 10, column: 4 } },
				},
			],
		}),
		display,
		renderContext('dotnet', { file: '/project/source.cs' }),
	);

	assert.deepEqual(
		rendered.symbols.map((symbol) => symbol.name),
		['Demo::First', 'Demo::Second'],
	);
	assert.equal(rendered.folds.length, 2);
	assert.deepEqual(rendered.metrics, {
		methodCount: 2,
		instructionCount: 6,
		labelCount: 6,
		codeSizeBytes: 8,
	});
	assert.deepEqual(
		rendered.links.map((link) => rendered.lines[link.targetLine].text.trim()),
		['IL_0003: ret', 'IL_0003: ret'],
	);
	assert.notEqual(rendered.links[0].targetLine, rendered.links[1].targetLine);
	assert.ok(rendered.links.every((link) => link.edgeKind === 'unconditional'));
	assert.deepEqual(
		rendered.lines.filter((line) => line.source).map((line) => [line.source?.line, line.source?.column]),
		[
			[3, 1],
			[3, 1],
			[10, 3],
			[10, 3],
			[10, 3],
		],
	);
});

/** Restates where the compiler ran, which is what relative debug paths resolve against. */
function compiledIn(workingDirectory: string, raw: RawArtifact): RawArtifact {
	return { ...raw, command: { ...raw.command, workingDirectory: path.resolve(workingDirectory) } };
}

test('malformed tool output still produces a valid rendered artifact', async () => {
	const ir = await render['llvm-ir'].renderer(rawArtifact('llvm-ir', 'not llvm ir'), display, renderContext('clang'));
	assert.equal(ir.lines.length, 1);
	assert.deepEqual(ir.sourceLocations, []);
	assert.deepEqual(ir.symbols, []);
});
