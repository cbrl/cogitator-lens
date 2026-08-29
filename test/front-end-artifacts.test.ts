import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import test from 'node:test';
import { artifactDefinitions } from '../src/artifacts/artifact-definitions.js';
import {
	pythonAstHelper,
} from '../src/artifacts/front-end-producers.js';
import {
	rustArtifactArguments,
} from '../src/artifacts/compiler-output-producer.js';
import { ToolchainBackend } from '../src/toolchains/toolchain-backend.js';
import {
	resolveArtifactAvailability,
	toolchainDefinitions,
} from '../src/toolchains/toolchain-map.js';
import {
	defaultArtifactOptions,
	type ArtifactKind,
	type ArtifactRenderContext,
	type RawArtifact,
	type ToolchainKind,
	type ToolchainProfile,
} from '../src/types/index.js';

test('v0.5 artifact availability matches the planned toolchain matrix', () => {
	for (const kind of ['gcc', 'clang', 'apple-clang', 'clang-cl', 'msvc'] as const) {
		assert.equal(availability(kind, 'preprocessed-source'), 'available');
	}
	for (const kind of ['clang', 'apple-clang', 'clang-cl', 'python'] as const) {
		assert.equal(availability(kind, 'ast'), 'available');
	}
	assert.equal(availability('gcc', 'ast'), 'unsupported');
	assert.equal(availability('msvc', 'ast'), 'unsupported');
	assert.equal(availability('rust', 'rust-mir'), 'available');
	assert.equal(availability('rust', 'llvm-ir'), 'available');
});

test('toolchain specifications own preprocessing and Python AST execution modes', async () => {
	for (const [kind, expected] of [
		['gcc', ['-E']],
		['msvc', ['/E']],
	] as const) {
		let received: readonly string[] = [];
		const fakeBackend = {
			profile: { kind },
			produceStdoutArtifact: async (
				_artifactKind: ArtifactKind,
				_source: unknown,
				_options: unknown,
				spec: {
					arguments: (
						temporaryDirectory: string,
						providerArguments: readonly string[],
					) => readonly string[];
				},
			) => {
				received = spec.arguments('/temporary', []);
				return rawArtifact('preprocessed-source', '');
			},
		};
		const cell = toolchainDefinitions[kind].artifacts['preprocessed-source'];
		assert.equal(cell.status, 'available');
		if (cell.status !== 'available' || cell.outputs !== undefined) {
			continue;
		}
		await cell.producer(
			fakeBackend as never,
			{} as never,
			{ productionOptions: defaultArtifactOptions.production },
			{} as never,
		);
		assert.deepEqual(received, expected);
	}
	assert.match(pythonAstHelper, /tokenize\.open/);
	assert.match(pythonAstHelper, /ast\.parse/);
	assert.doesNotMatch(pythonAstHelper, /\bimport_module\b|\bexecfile\b/);
});

test('Rust MIR and LLVM IR arguments preserve crate identity and own emit output', () => {
	assert.deepEqual(rustArtifactArguments('mir', 'artifact.mir', []), [
		'--crate-name=coglens_artifact',
		'--crate-type=lib',
		'--emit=mir=artifact.mir',
		'--error-format=human',
		'--color=never',
	]);
	assert.deepEqual(
		rustArtifactArguments(
			'llvm-ir',
			'artifact.ll',
			['--crate-name=real', '--crate-type', 'rlib'],
		),
		[
			'--emit=llvm-ir=artifact.ll',
			'-C',
			'debuginfo=1',
			'--error-format=human',
			'--color=never',
		],
	);
});

test('preprocessed renderer maps line markers and rerenders include filtering', () => {
	const source = path.resolve('/project/source.cpp');
	const header = path.resolve('/project/header.h');
	const raw = rawArtifact('preprocessed-source', [
		`# 1 "${source}"`,
		'int own;',
		`# 7 "${header}" 1`,
		'int included;',
		`#line 2 "${source}"`,
		'int own_again;',
	].join('\n'));
	const context = renderContext('gcc', source);
	const shown = artifactDefinitions['preprocessed-source'].renderer(
		raw,
		defaultArtifactOptions.display,
		context,
	);
	assert.equal(shown.lines.find(line => line.text === 'int included;')?.source?.line, 7);
	assert.equal(shown.metrics.includedFileCount, 1);

	const hidden = artifactDefinitions['preprocessed-source'].renderer(
		raw,
		{ ...defaultArtifactOptions.display, showIncludedFiles: false },
		context,
	);
	assert.equal(hidden.lines.some(line => line.text === 'int included;'), false);
	assert.equal(hidden.lines.find(line => line.text === 'int own_again;')?.source?.line, 2);
});

test('Clang AST rendering removes addresses, filters system subtrees, and adds symbols', () => {
	const source = path.resolve('/project/source.cpp');
	const raw = rawArtifact('ast', [
		'TranslationUnitDecl 0x1234 <<invalid sloc>>',
		`|-FunctionDecl 0xABCD <${source}:1:1, line:3:1> line:1:5 main 'int ()'`,
		'| `-CompoundStmt 0x00ff <col:12, line:3:1>',
		"`-FunctionDecl 0x9999 </usr/include/stdio.h:2:1, col:10> system_fn 'void ()'",
		'  `-CompoundStmt 0x8888 <col:11, col:12>',
	].join('\n'));
	const rendered = artifactDefinitions.ast.renderer(
		raw,
		defaultArtifactOptions.display,
		renderContext('clang', source),
	);
	assert.equal(rendered.lines.some(line => /0x[0-9a-f]/i.test(line.text)), false);
	assert.equal(rendered.lines.some(line => line.text.includes('system_fn')), false);
	assert.deepEqual(rendered.symbols, [{ name: 'main', line: 1 }]);
	assert.equal(rendered.lines[1].source?.line, 1);
	assert.equal(rendered.lines[1].source?.column, 0);
	assert.equal(rendered.lines[1].source?.endLine, 3);
	assert.equal(rendered.lines[1].source?.endColumn, 1);
});

test('Python AST and Rust MIR render folds, symbols, locations, and block links', () => {
	const source = path.resolve('/project/source.py');
	const python = artifactDefinitions.ast.renderer(
		rawArtifact('ast', [
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
		].join('\n')),
		defaultArtifactOptions.display,
		renderContext(
			'python',
			source,
			'first\nsecond\nthird\n  def answer()',
		),
	);
	assert.deepEqual(python.symbols, [{ name: 'answer', line: 2 }]);
	assert.equal(python.lines[2].source?.line, 4);
	assert.equal(python.lines[2].source?.column, 2);
	assert.equal(python.lines[2].source?.endLine, 4);
	assert.equal(python.lines[2].source?.endColumn, 14);
	assert.ok(python.folds.some(fold => fold.startLine === 2));

	const rustSource = path.resolve('/project/source.rs');
	const mir = artifactDefinitions['rust-mir'].renderer(
		rawArtifact('rust-mir', [
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
		].join('\n')),
		defaultArtifactOptions.display,
		renderContext('rust', rustSource),
	);
	assert.deepEqual(mir.symbols, [{ name: 'choose', line: 0 }]);
	assert.equal(mir.metrics.basicBlockCount, 3);
	assert.ok(mir.links.some(link => link.line === 2 && link.targetLine === 4));
	assert.ok(mir.folds.some(fold => fold.startLine === 0 && fold.endLine === 10));
});

test('Python AST source spans convert UTF-8 offsets to editor columns', () => {
	const source = path.resolve('/project/unicode.py');
	const rendered = artifactDefinitions.ast.renderer(
		rawArtifact('ast', [
			'Name(',
			"  id='value',",
			'  ctx=Load(),',
			'  lineno=1,',
			'  col_offset=5,',
			'  end_lineno=1,',
			'  end_col_offset=10)',
		].join('\n')),
		defaultArtifactOptions.display,
		renderContext('python', source, 'é = value'),
	);
	assert.deepEqual(rendered.lines[0].source, {
		file: source,
		line: 1,
		column: 4,
		endLine: 1,
		endColumn: 9,
		mainSource: true,
	});
});

test('installed Rust and Python toolchains produce v0.5 artifacts without side effects', async t => {
	const temporary = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'coglens-front-end-'));
	try {
	if (commandExists('rustc')) {
		const source = path.resolve('test/fixtures/front-end/source.rs');
		for (const [emit, extension] of [['mir', '.mir'], ['llvm-ir', '.ll']] as const) {
			const output = path.join(temporary, `artifact${extension}`);
			const result = childProcess.spawnSync(
				'rustc',
				[...rustArtifactArguments(emit, output, []), source],
				{ encoding: 'utf8', windowsHide: true },
			);
			assert.equal(result.status, 0, result.stderr);
			const text = await fs.promises.readFile(output, 'utf8');
			assert.ok(text.length > 0);
			if (emit === 'mir') {
				const rendered = artifactDefinitions['rust-mir'].renderer(
					rawArtifact('rust-mir', text),
					defaultArtifactOptions.display,
					renderContext('rust', source),
				);
				assert.ok(rendered.symbols.some(symbol => symbol.name === 'choose'));
			}
		}
	} else {
		t.diagnostic('rustc is not installed; skipping Rust integration probe');
	}

	if (commandExists('python')) {
		const result = childProcess.spawnSync(
			'python',
			[
				'-I',
				'-c',
				pythonAstHelper,
				path.resolve('test/fixtures/front-end/source.py'),
			],
			{ encoding: 'utf8', windowsHide: true },
		);
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /FunctionDef/);
		assert.match(result.stdout, /RuntimeError/);
		const rendered = artifactDefinitions.ast.renderer(
			rawArtifact('ast', result.stdout),
			defaultArtifactOptions.display,
			renderContext('python', path.resolve('test/fixtures/front-end/source.py')),
		);
		assert.ok(rendered.symbols.some(symbol => symbol.name === 'answer'));
	} else {
		t.diagnostic('python is not installed; skipping Python integration probe');
	}
	} finally {
		await fs.promises.rm(temporary, { recursive: true, force: true });
	}
});

function availability(toolchain: ToolchainKind, artifact: ArtifactKind): string {
	return resolveArtifactAvailability(profile(toolchain), artifact).status;
}

function renderContext(
	kind: ToolchainKind,
	sourceFile: string,
	sourceText = '',
): ArtifactRenderContext {
	return {
		backend: new ToolchainBackend(profile(kind), toolchainDefinitions[kind]),
		source: {
			uri: { fsPath: sourceFile } as never,
			text: sourceText,
		},
	};
}

function profile(kind: ToolchainKind): ToolchainProfile {
	return {
		id: `test:${kind}`,
		displayName: `Test ${kind}`,
		kind,
		executable: process.execPath,
		defaultArguments: [],
		environment: {},
		tools: {},
	};
}

function rawArtifact(kind: ArtifactKind, text: string): RawArtifact {
	return {
		kind,
		text,
		diagnostics: [],
		durationMs: 1,
		generatedAt: 0,
		command: {
			executable: process.execPath,
			arguments: [],
			environmentVariableNames: [],
			workingDirectory: path.resolve('/project'),
		},
		truncated: false,
		inputs: [],
		dependencyCoverage: 'source-only',
	};
}

function commandExists(command: string): boolean {
	return childProcess.spawnSync(command, ['--version'], {
		stdio: 'ignore',
		windowsHide: true,
	}).status === 0;
}
