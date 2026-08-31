import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { artifactDefinitions } from '../src/artifacts/core/artifact-definitions.js';
import { stripPythonManagedArguments } from '../src/toolchains/python.js';
import { toolchainDefinitions } from '../src/toolchains/toolchain-map.js';
import {
	defaultArtifactOptions,
	type ArtifactKind,
	type ArtifactRenderContext,
	type RawArtifact,
} from '../src/types/index.js';

test('Python bytecode producer owns module dispatch and uses stdout', async () => {
	const cell = toolchainDefinitions.python.artifacts['python-bytecode'];
	assert.equal(cell.status, 'available');
	if (cell.status !== 'available' || cell.outputs !== undefined) {
		return;
	}

	let receivedKind: ArtifactKind | undefined;
	let receivedArguments: readonly string[] | undefined;
	let receivedOutput: unknown;
	const fakeBackend = {
		produceArtifact: async (
			kind: ArtifactKind,
			_source: unknown,
			_options: unknown,
			spec: {
				output: unknown;
				arguments: (
					outputFile: string,
					temporaryDirectory: string,
					providerArguments: readonly string[],
				) => readonly string[];
			},
		) => {
			receivedKind = kind;
			receivedOutput = spec.output;
			receivedArguments = spec.arguments('', '/temporary', []);
			return rawArtifact('');
		},
	};

	await cell.producer(
		fakeBackend as never,
		{} as never,
		{ productionOptions: defaultArtifactOptions.production },
		{} as never,
	);
	assert.equal(receivedKind, 'python-bytecode');
	assert.equal(receivedOutput, 'stdout');
	assert.deepEqual(receivedArguments, ['-m', 'dis']);
});

test('Python argument stripping removes only extension-owned execution modes and source paths', () => {
	const workingDirectory = process.cwd();
	const source = path.join(workingDirectory, 'main.py');
	assert.deepEqual(
		stripPythonManagedArguments(['-O', '-X', 'dev', '-m', 'module', './main.py', '--'], source, workingDirectory),
		['-O', '-X', 'dev'],
	);
	assert.deepEqual(stripPythonManagedArguments(['-cprint(1)', '-mtrace', '-B'], source, workingDirectory), ['-B']);
});

test('Python bytecode renderer maps supported disassembly layouts to source lines', () => {
	const raw = rawArtifact(
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

	const rendered = artifactDefinitions['python-bytecode'].renderer(
		raw,
		defaultArtifactOptions.display,
		renderContext(),
	);
	const mapped = rendered.lines.filter((line) => line.source);
	assert.deepEqual([...new Set(mapped.map((line) => line.source?.line))], [1, 2, 3]);
	assert.ok(mapped.every((line) => line.source?.file === 'C:\\project\\main.py'));
	assert.ok(mapped.every((line) => line.source?.mainSource));
	assert.equal(rendered.metrics.instructionCount, 7);
	assert.equal(rendered.metrics.codeObjectCount, 2);
	assert.equal(rendered.metrics.sourceLineCount, 3);

	const offsetBearing = artifactDefinitions['python-bytecode'].renderer(
		rawArtifact(
			[
				'  1           0 LOAD_CONST               0 (1)',
				'              2 STORE_NAME               0 (value)',
				'              4 RETURN_VALUE',
			].join('\n'),
		),
		defaultArtifactOptions.display,
		renderContext(),
	);
	assert.ok(offsetBearing.lines.every((line) => line.source?.line === 1));
	assert.equal(offsetBearing.metrics.instructionCount, 3);
});

function renderContext(): ArtifactRenderContext {
	return {
		backend: {} as never,
		source: {
			uri: { fsPath: 'C:\\project\\main.py' } as never,
			text: 'def add(a, b):\n    return a + b\n',
		},
	};
}

function rawArtifact(text: string): RawArtifact {
	return {
		kind: 'python-bytecode',
		text,
		diagnostics: [],
		durationMs: 1,
		generatedAt: 0,
		command: {
			executable: process.execPath,
			arguments: ['-m', 'dis', 'C:\\project\\main.py'],
			environmentVariableNames: [],
			workingDirectory: 'C:\\project',
		},
		truncated: false,
		inputs: [],
		dependencyCoverage: 'source-only',
	};
}
