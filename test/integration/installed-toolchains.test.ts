/**
 * Probes against real toolchains.
 *
 * Everything here needs a compiler on PATH and skips when it is absent, so the
 * assertions cover what a fixture cannot: that the arguments the extension
 * builds are accepted, that the output still has the shape the parsers expect,
 * and that the isolated Python helpers compile rather than execute a module.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { artifactDefinitions } from '../../src/artifacts/core/artifact-definitions.js';
import { pythonAstHelper } from '../../src/artifacts/ast/python-ast-producer.js';
import { renderPythonAst } from '../../src/artifacts/ast/ast-renderer.js';
import { rustArtifactArguments } from '../../src/toolchains/rust.js';
import { controlFlowGraphMetrics } from '../../src/artifacts/control-flow-graph/control-flow-graph-model.js';
import { parsePythonControlFlowGraphs } from '../../src/artifacts/control-flow-graph/parsers/python-cfg-parser.js';
import { pythonCfgHelper } from '../../src/artifacts/python/python-cfg-producer.js';
import {
	parsePythonStackUsage,
	pythonStackAnalysisHelper,
} from '../../src/artifacts/stack-analysis/python-stack-analysis.js';
import { inferGoSsaFunction } from '../../src/toolchains/go.js';
import { ToolExitError, ToolchainBackend } from '../../src/toolchains/toolchain-backend.js';
import { fileURLToPath } from 'node:url';
import { sameLocalFile } from '../../src/file-identity.js';
import { renderJavaBytecode } from '../../src/artifacts/java/java-bytecode-renderer.js';
import { findExecutableOnPath } from '../../src/toolchains/path-detection.js';
import { createToolchainProfile, toolchainDefinitions } from '../../src/toolchains/toolchain-map.js';
import { defaultArtifactOptions } from '../../src/types/index.js';
import { rawArtifact, renderContext, renderGraphs } from '../support/artifacts.js';
import { fixturePath, requireCommand, run } from '../support/environment.js';
import {
	declaredImplementation,
	declaredOutput,
	neverCancelled,
	sourceUri,
	testToolchainHost,
	toolchainBackend,
} from '../support/toolchains.js';

const display = defaultArtifactOptions.display;

test('rustc emits MIR and LLVM IR through the extension arguments', async (t) => {
	if (!requireCommand(t, 'rustc')) {
		return;
	}
	const source = fixturePath('front-end', 'source.rs');
	const temporary = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'coglens-rust-'));
	try {
		for (const [emit, extension] of [
			['mir', '.mir'],
			['llvm-ir', '.ll'],
		] as const) {
			const output = path.join(temporary, `artifact${extension}`);
			const result = run('rustc', [...rustArtifactArguments(emit, output, []), source]);
			assert.equal(result.status, 0, result.stderr);
			const text = await fs.promises.readFile(output, 'utf8');
			assert.ok(text.length > 0);
			if (emit === 'mir') {
				const rendered = artifactDefinitions['rust-mir'].renderer(
					rawArtifact('rust-mir', text),
					display,
					renderContext('rust', { file: source }),
				);
				assert.ok(rendered.symbols.some((symbol) => symbol.name === 'choose'));
			}
		}
	} finally {
		await fs.promises.rm(temporary, { recursive: true, force: true });
	}
});

test('rustc assembly output produces a machine-level control-flow graph', async (t) => {
	if (!requireCommand(t, 'rustc')) {
		return;
	}
	const source = fixturePath('front-end', 'source.rs');
	const result = run('rustc', [
		'--crate-name=coglens_cfg_probe',
		'--crate-type=lib',
		'--emit=asm=-',
		'-C',
		'debuginfo=1',
		source,
	]);
	assert.equal(result.status, 0, result.stderr);

	const rendered = await renderGraphs(
		declaredOutput('rust', 'control-flow-graph', 'assembly'),
		rawArtifact('control-flow-graph', result.stdout),
		renderContext(toolchainBackend('rust'), { file: source }),
	);
	assert.ok(rendered.graphs.some((graph) => graph.label.includes('choose')));
	assert.ok(rendered.graphs.some((graph) => graph.edges.length >= 2));
});

test('the Python AST helper reports definitions without importing the module', (t) => {
	if (!requireCommand(t, 'python')) {
		return;
	}
	const source = fixturePath('front-end', 'source.py');
	const result = run('python', ['-I', '-c', pythonAstHelper, source]);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /FunctionDef/u);
	// The fixture raises at import time; the helper never reaches that code.
	assert.match(result.stdout, /RuntimeError/u);

	const rendered = renderPythonAst(
		rawArtifact('ast', result.stdout),
		display,
		renderContext('python', { file: source }),
	);
	assert.ok(rendered.symbols.some((symbol) => symbol.name === 'answer'));
});

test('the Python control-flow helper compiles the module and yields parseable graphs', (t) => {
	if (!requireCommand(t, 'python')) {
		return;
	}
	const source = fixturePath('control-flow', 'python.py');
	const result = run('python', ['-I', '-c', pythonCfgHelper, source]);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /"codeObjects"/u);
	assert.doesNotMatch(result.stderr, /Cogitator Lens must compile, not execute|RuntimeError/u);

	const parsed = parsePythonControlFlowGraphs(result.stdout, path.dirname(source));
	assert.deepEqual(parsed.diagnostics, []);
	assert.ok(parsed.graphs.length >= 5);
	assert.ok(parsed.graphs.some((graph) => graph.label.includes('inner')));
	assert.ok(
		parsed.graphs.some(
			(graph) =>
				graph.edges.some((edge) => edge.kind === 'true') && graph.edges.some((edge) => edge.kind === 'false'),
		),
	);
	assert.ok(parsed.graphs.some((graph) => graph.nodes.some((node) => node.terminal === 'throw')));

	// A generator's prologue is entered normally, so it is neither terminal nor unreachable.
	const generator = parsed.graphs.find((graph) => graph.label === 'classify');
	assert.ok(generator);
	assert.match(generator.nodes[0].label, /RETURN_GENERATOR/u);
	assert.equal(generator.nodes[0].terminal, undefined);
	assert.equal(controlFlowGraphMetrics([generator]).unreachableNodeCount, 0);
});

test('the Python stack helper walks nested code objects without running the module', (t) => {
	if (!requireCommand(t, 'python')) {
		return;
	}
	const source = fixturePath('stack-analysis', 'source.py');
	const sideEffectMarker = `${source}.executed`;
	fs.rmSync(sideEffectMarker, { force: true });

	const result = run('python', ['-I', '-c', pythonStackAnalysisHelper, source]);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(fs.existsSync(sideEffectMarker), false, 'module side effect must not run');

	const records = parsePythonStackUsage(result.stdout);
	const names = records.map((record) => record.qualifiedName);
	for (const expected of [
		'<module>',
		'outer',
		'Handler',
		'Handler.handle',
		'<lambda>',
		'<genexpr>',
		'coroutine',
		'café',
	]) {
		assert.ok(names.includes(expected), `missing code object ${expected}`);
	}
	assert.ok(
		names.some((name) => name === 'outer.inner' || name === 'outer.<locals>.inner'),
		'missing nested inner code object',
	);
	assert.ok(records.every((record) => Number.isSafeInteger(record.stackSize)));
});

test('the Python stack helper honors declared encodings and reports syntax errors', async (t) => {
	if (!requireCommand(t, 'python')) {
		return;
	}
	const temporary = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'coglens-python-stack-'));
	try {
		const encodedSource = path.join(temporary, 'encoded.py');
		await fs.promises.writeFile(
			encodedSource,
			Buffer.from('# coding: latin-1\ndef caf\xe9():\n    return 1\n', 'latin1'),
		);
		const encoded = run('python', ['-I', '-c', pythonStackAnalysisHelper, encodedSource]);
		assert.equal(encoded.status, 0, encoded.stderr);
		assert.ok(parsePythonStackUsage(encoded.stdout).some((record) => record.qualifiedName === 'café'));

		const invalidSource = path.join(temporary, 'invalid.py');
		await fs.promises.writeFile(invalidSource, 'def broken(:\n    pass\n');
		const invalid = run('python', ['-I', '-c', pythonStackAnalysisHelper, invalidSource]);
		assert.notEqual(invalid.status, 0);
		assert.match(invalid.stderr, /SyntaxError/u);
		assert.equal(invalid.stdout, '');
	} finally {
		await fs.promises.rm(temporary, { recursive: true, force: true });
	}
});

test('the Python bytecode producer ignores modules beside the source', async (t) => {
	if (!requireCommand(t, 'python')) {
		return;
	}
	const temporary = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'coglens-python-shadow-'));
	try {
		const source = path.join(temporary, 'main.py');
		await fs.promises.writeFile(source, 'def answer():\n    return 42\n');
		// Each module replaces a standard module that `python -m dis` imports.
		for (const name of ['dis', 'opcode']) {
			await fs.promises.writeFile(path.join(temporary, `${name}.py`), `print("SHADOWED ${name}")\n`);
		}
		const produced = await declaredImplementation('python', 'assembly').producer(
			toolchainBackend('python', { executable: 'python' }),
			sourceUri(source),
			{ workingDirectory: temporary, productionOptions: defaultArtifactOptions.production },
			neverCancelled,
		);
		assert.doesNotMatch(produced.text, /SHADOWED/u);
		assert.match(produced.text, /RETURN_(?:VALUE|CONST)/u);
	} finally {
		await fs.promises.rm(temporary, { recursive: true, force: true });
	}
});

test('the Go compiler produces normalized assembly and a GOSSAFUNC graph', async (t) => {
	if (!requireCommand(t, 'go', 'version')) {
		return;
	}
	const source = fixturePath('go', 'source.go');
	const options = { workingDirectory: path.dirname(source), productionOptions: defaultArtifactOptions.production };
	const backend = toolchainBackend('go', { executable: 'go' });
	assert.equal(await inferGoSsaFunction(source), 'command-line-arguments.classify');

	const assembly = await declaredImplementation('go', 'assembly').producer(
		backend,
		sourceUri(source),
		options,
		neverCancelled,
	);
	assert.ok(
		backend
			.parseAssembly(assembly.text, display, { path: source, workingDirectory: assembly.command.cwd })
			.asm.some((line) => /TEXT|CMPQ|JLE|NEGQ|RET/u.test(line.text)),
	);

	const output = declaredOutput('go', 'control-flow-graph', 'go-ssa');
	const rawGraph = await output.producer(backend, sourceUri(source), options, neverCancelled);
	// The SSA dump is captured in a temporary directory, never beside the source.
	assert.equal(fs.existsSync(path.join(path.dirname(source), 'ssa.html')), false);
	const rendered = await renderGraphs(
		output,
		{ ...rawGraph, kind: 'control-flow-graph' },
		{ backend, source: { uri: sourceUri(source), text: fs.readFileSync(source, 'utf8') } },
	);
	assert.ok(rendered.graphs.some((graph) => graph.label === 'classify'));
});

test('javac and javap produce line-mapped JVM bytecode for a source of a package', async (t) => {
	if (!requireCommand(t, 'javac', '-version')) {
		return;
	}
	const javac = await findExecutableOnPath('javac');
	assert.ok(javac);
	const profile = createToolchainProfile('java', 'javac', javac);
	if (!profile.tools.javap) {
		t.skip(`javap was not found for ${javac}`);
		return;
	}
	const backend = new ToolchainBackend(profile, toolchainDefinitions.java, testToolchainHost);
	const source = fixturePath('java', 'src', 'com', 'example', 'Shapes.java');
	const options = { productionOptions: defaultArtifactOptions.production };
	const produced = await declaredImplementation('java', 'assembly').producer(
		backend,
		sourceUri(source),
		options,
		neverCancelled,
	);
	assert.equal(produced.command.executable, profile.tools.javap.executable);
	// javac read Helper.java from the source root that the package declaration gives.
	assert.equal(produced.dependencyCoverage, 'complete');
	const inputs = produced.inputs.map((input) => fileURLToPath(input.uri));
	for (const file of [source, fixturePath('java', 'src', 'com', 'example', 'Helper.java')]) {
		assert.ok(
			inputs.some((input) => sameLocalFile(input, file)),
			inputs.join('\n'),
		);
	}
	const rendered = renderJavaBytecode(
		{ ...produced, kind: 'assembly' },
		display,
		renderContext('java', { file: source }),
	);
	assert.deepEqual(
		rendered.symbols.map((symbol) => symbol.name).filter((name) => name.startsWith('com.example.Shapes.s')),
		['com.example.Shapes.sum(int[])', 'com.example.Shapes.square(double)'],
	);
	const sum = rendered.symbols.find((symbol) => symbol.name === 'com.example.Shapes.sum(int[])');
	assert.ok(sum);
	const add = rendered.lines.findIndex((line, index) => index > sum.line && /: iadd$/u.test(line.text));
	assert.equal(rendered.lines[add].source?.line, 22);
	assert.ok(rendered.lines.every((line) => !/^\s*(?:Code|LineNumberTable):$/u.test(line.text)));
	// The listing has the classes of this source only, though javac also read Helper.java.
	assert.ok(rendered.lines.every((line) => !/class com\.example\.Helper/u.test(line.text)));

	// With --release, javac loads the classes of the JDK from ct.sym. These are not inputs, so each
	// input is a file, and the next request can use the output again.
	const release = await declaredImplementation('java', 'assembly').producer(
		backend,
		sourceUri(source),
		// The fixture has records and switch expressions, which need Java 16.
		{ ...options, args: ['--release', '17'] },
		neverCancelled,
	);
	assert.ok(
		release.inputs.length > 0 && release.inputs.every((input) => input.size >= 0),
		release.inputs.map((input) => `${input.uri} ${input.size}`).join('\n'),
	);

	const temporary = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'coglens-java-'));
	try {
		const empty = path.join(temporary, 'Empty.java');
		await fs.promises.writeFile(empty, '// No class.\n');
		const nothing = await declaredImplementation('java', 'assembly').producer(
			backend,
			sourceUri(empty),
			options,
			neverCancelled,
		);
		assert.equal(nothing.text, '');
		assert.equal(nothing.command.executable, javac);
	} finally {
		await fs.promises.rm(temporary, { recursive: true, force: true });
	}
});

test('nvcc produces line-mapped PTX and nvdisasm produces SASS', async (t) => {
	if (!requireCommand(t, 'nvcc')) {
		return;
	}
	const source = fixturePath('cuda', 'kernel.cu');
	const options = { workingDirectory: path.dirname(source), productionOptions: defaultArtifactOptions.production };
	const backend = toolchainBackend('nvcc', { executable: 'nvcc' });

	let raw;
	try {
		raw = await declaredImplementation('nvcc', 'assembly').producer(
			backend,
			sourceUri(source),
			options,
			neverCancelled,
		);
	} catch (error) {
		// Each CUDA release accepts only some MSVC toolsets, and the headers of a newer one stop the compile.
		if (error instanceof ToolExitError && /STL1002|unsupported Microsoft Visual Studio/u.test(error.stdout)) {
			t.skip('nvcc does not support the default Visual Studio toolset of this host');
			return;
		}
		throw error;
	}
	assert.match(raw.text, /\.visible\s+\.entry\s+saxpy/u);
	const parsed = backend.parseAssembly(raw.text, display, { path: source, workingDirectory: raw.command.cwd });
	assert.ok(parsed.asm.some((line) => /fma\.rn\.f32|mul\.wide|st\.global/u.test(line.text)));
	assert.ok(parsed.asm.some((line) => line.source?.file?.endsWith('kernel.cu')));

	const sassBackend = toolchainBackend('nvcc', {
		executable: 'nvcc',
		tools: { disassembler: { executable: 'nvdisasm', inputMode: 'stdin' } },
	});
	const sass = await declaredImplementation('nvcc', 'binary-disassembly').producer(
		sassBackend,
		sourceUri(source),
		options,
		neverCancelled,
	);
	const parsedSass = sassBackend.parseBinaryDisassembly(sass.text, display, {
		path: source,
		workingDirectory: sass.command.cwd,
	});
	assert.ok(parsedSass.asm.some((line) => /FMA|STG|EXIT/u.test(line.disassembly ?? line.text)));
	assert.ok(parsedSass.asm.some((line) => line.address !== undefined && line.opcodes?.length));
});

test('cmd can call a quoted environment script path verbatim', async (t) => {
	if (process.platform !== 'win32') {
		t.skip('Windows command-processor behavior is only applicable on Windows.');
		return;
	}
	const commandProcessor = findWindowsCommandProcessor();
	if (!commandProcessor) {
		t.skip('No Windows command processor was found through ComSpec, SystemRoot, or PATH.');
		return;
	}
	const { execute } = await import('../../src/exec.js');
	const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'coglens quoted path '));
	const script = path.join(directory, 'capture environment.cmd');
	try {
		await fs.promises.writeFile(script, '@echo off\r\necho environment-captured\r\n');
		const result = await execute(commandProcessor, ['/d', '/s', '/c', `call "${script}"`], {
			windowsVerbatimArguments: true,
		});
		assert.equal(result.returnCode, 0);
		assert.match(result.stdout, /environment-captured/u);
	} finally {
		await fs.promises.rm(directory, { recursive: true, force: true });
	}
});

function findWindowsCommandProcessor(): string | undefined {
	const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
	return [
		process.env.ComSpec ?? process.env.COMSPEC,
		systemRoot ? path.join(systemRoot, 'System32', 'cmd.exe') : undefined,
		...(process.env.PATH ?? '')
			.split(path.delimiter)
			.filter(Boolean)
			.map((directory) => path.join(directory, 'cmd.exe')),
	].find((candidate): candidate is string => typeof candidate === 'string' && fs.existsSync(candidate));
}
