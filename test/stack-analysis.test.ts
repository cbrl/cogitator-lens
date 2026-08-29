import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { artifactDefinitions } from '../src/artifacts/artifact-definitions.js';
import {
	clangClStackUsageOutput,
	nativeStackUsageOutput,
	parseStackUsage,
} from '../src/artifacts/stack-analysis.js';
import {
	parsePythonStackUsage,
	pythonStackAnalysisHelper,
} from '../src/artifacts/python-stack-analysis.js';
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

test('v0.6 stack-analysis availability matches the planned toolchain matrix', () => {
	for (const kind of ['gcc', 'clang', 'apple-clang', 'clang-cl', 'python'] as const) {
		assert.equal(availability(kind), 'available');
	}
	for (const kind of ['msvc', 'rust'] as const) {
		assert.equal(availability(kind), 'unsupported');
	}
});

test('native stack specifications own deterministic object and .su output names', () => {
	assert.deepEqual(nativeStackUsageOutput.arguments('output.su', '/temporary', []), [
		'-c',
		'-fstack-usage',
		'-fno-lto',
		'-o',
		path.join('/temporary', 'output.o'),
	]);
	assert.deepEqual(
		clangClStackUsageOutput.arguments(
			'C:\\temporary\\output.su',
			'C:\\temporary',
			[],
		),
		[
			'/c',
			'/clang:-fstack-usage',
			'/clang:-fno-lto',
			'/clang:-gline-tables-only',
			'/clang:-o',
			`/clang:${path.join('C:\\temporary', 'output.obj')}`,
		],
	);
});

test('.su parser handles Clang locations, locationless records, and GCC 17 symbols', () => {
	const workingDirectory = path.resolve('/work');
	const parsed = parseStackUsage([
		'src/source.c:3:clang_function\t24\tstatic',
		'C:\\work dir\\source.c:8:?windows_function@@YAHH@Z\t40\tdynamic',
		'src/source.c:locationless_function\t12\tstatic',
		'src/source.c:11:2:gcc_function\t_Z12gcc_functionv\t32\tdynamic,bounded',
	].join('\n'), workingDirectory);

	assert.equal(parsed.diagnostics.length, 0);
	assert.deepEqual(parsed.entries.map(entry => ({
		functionName: entry.functionName,
		sourceLine: entry.sourceLine,
		sourceColumn: entry.sourceColumn,
		value: entry.value,
		qualifier: entry.qualifier,
	})), [
		{
			functionName: 'clang_function',
			sourceLine: 3,
			sourceColumn: undefined,
			value: 24,
			qualifier: 'static',
		},
		{
			functionName: '?windows_function@@YAHH@Z',
			sourceLine: 8,
			sourceColumn: undefined,
			value: 40,
			qualifier: 'dynamic',
		},
		{
			functionName: 'locationless_function',
			sourceLine: undefined,
			sourceColumn: undefined,
			value: 12,
			qualifier: 'static',
		},
		{
			functionName: 'gcc_function',
			sourceLine: 11,
			sourceColumn: 2,
			value: 32,
			qualifier: 'dynamic-bounded',
		},
	]);
	assert.equal(parsed.entries[1]?.sourceUri, path.win32.normalize('C:\\work dir\\source.c'));
});

test('.su parser handles dialect qualifiers, punctuation, duplicates, malformed input, and Windows paths', () => {
	const workingDirectory = path.resolve('/work');
	const parsed = parseStackUsage(
		fs.readFileSync('test/fixtures/stack-analysis/gcc-clang.su', 'utf8'),
		workingDirectory,
	);
	assert.equal(parsed.entries.length, 4);
	assert.equal(parsed.diagnostics.length, 3);
	assert.deepEqual(parsed.entries.map(entry => ({
		functionName: entry.functionName,
		value: entry.value,
		qualifier: entry.qualifier,
	})), [
		{ functionName: 'plain(int)', value: 16, qualifier: 'static' },
		{
			functionName: 'network::Parser::parse<std::pair<int, int> >(char const*)',
			value: 32,
			qualifier: 'dynamic-bounded',
		},
		{ functionName: 'lambda_factory()::<lambda(int)>', value: 64, qualifier: 'dynamic' },
		{ functionName: 'bounded_alias()', value: 24, qualifier: 'dynamic-bounded' },
	]);
	assert.equal(parsed.entries[0].sourceUri, path.resolve(workingDirectory, 'src/source.cpp'));
	assert.equal(parsed.entries[2].sourceUri, path.win32.normalize('C:\\work dir\\source.cpp'));
	assert.deepEqual(parsed.diagnostics.map(item => item.line), [6, 7, 8]);
	const spacedQualifier = parseStackUsage(
		'src/source.cpp:1:1:spaced()\t8\tdynamic, bounded',
		workingDirectory,
	);
	assert.equal(spacedQualifier.diagnostics.length, 0);
	assert.equal(spacedQualifier.entries[0]?.qualifier, 'dynamic-bounded');
});

test('stack renderer creates separate source-linked annotations, unmapped entries, and metrics', () => {
	const source = path.resolve('/project/source.cpp');
	const raw = rawArtifact('stack-analysis', [
		`${source}:2:3:first()\t16\tstatic`,
		`${source}:2:7:second()\t32\tdynamic,bounded`,
		`${path.resolve('/project/header.h')}:1:1:header_fn()\t64\tdynamic`,
	].join('\n'));
	const rendered = artifactDefinitions['stack-analysis'].renderer(
		raw,
		defaultArtifactOptions.display,
		renderContext('gcc', source, 'first line\nsecond line\nthird line'),
	);
	assert.deepEqual(rendered.lines.slice(0, 4).map(line => line.text), [
		'first line',
		'',
		'',
		'second line',
	]);
	assert.deepEqual(rendered.lines[1].annotations, [{
		kind: 'stack-usage',
		functionName: 'first()',
		value: 16,
		unit: 'bytes',
		qualifier: 'static',
	}]);
	assert.equal(rendered.lines[1].source?.column, 2);
	assert.equal(rendered.lines[2].source?.column, 6);
	assert.ok(rendered.lines.some(line => line.text === 'Unmapped entries'));
	assert.ok(rendered.lines.some(line => line.text.includes('header_fn()')));
	assert.deepEqual(rendered.metrics, {
		functionCount: 3,
		largestFrame: 64,
		largestFrameUnit: 'bytes',
		totalKnownFrame: 112,
		totalKnownFrameUnit: 'bytes',
		dynamicFrameCount: 2,
		unmappedEntryCount: 1,
	});
});

test('Windows stack paths map to source annotations without losing the drive prefix', t => {
	if (process.platform !== 'win32') {
		t.skip('Windows path-to-source comparison is platform-specific');
		return;
	}
	const source = 'C:\\work dir\\source.cpp';
	const raw = rawArtifact(
		'stack-analysis',
		`${source}:2:1:windows_function()\t40\tstatic`,
	);
	const rendered = artifactDefinitions['stack-analysis'].renderer(
		raw,
		defaultArtifactOptions.display,
		renderContext('clang-cl', source, 'first line\nsecond line'),
	);
	const annotations = rendered.lines.flatMap(line => line.annotations ?? []);
	assert.ok(annotations.some(annotation =>
		annotation.kind === 'stack-usage'
		&& annotation.functionName === 'windows_function()'));
	assert.ok(!rendered.lines.some(line => line.text === 'Unmapped entries'));
});

test('Python helper recursively reports code objects without executing module side effects', t => {
	if (!commandExists('python')) {
		t.skip('python is not installed');
		return;
	}
	const source = path.resolve('test/fixtures/stack-analysis/source.py');
	const sideEffectMarker = `${source}.executed`;
	fs.rmSync(sideEffectMarker, { force: true });
	const result = childProcess.spawnSync(
		'python',
		['-I', '-c', pythonStackAnalysisHelper, source],
		{ encoding: 'utf8', windowsHide: true },
	);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(fs.existsSync(sideEffectMarker), false, 'module side effect must not run');
	const records = parsePythonStackUsage(result.stdout);
	const names = records.map(record => record.qualifiedName);
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
		names.some(name => name === 'outer.inner' || name === 'outer.<locals>.inner'),
		'missing nested inner code object',
	);
	assert.ok(records.every(record => Number.isSafeInteger(record.stackSize)));
	assert.match(pythonStackAnalysisHelper, /compile\(source,filename,'exec'\)/);
	assert.doesNotMatch(pythonStackAnalysisHelper, /\bexec\s*\(/);
});

test('Python helper honors declared source encodings and reports syntax errors', t => {
	if (!commandExists('python')) {
		t.skip('python is not installed');
		return;
	}
	const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'coglens-python-stack-'));
	try {
		const encodedSource = path.join(temporary, 'encoded.py');
		fs.writeFileSync(
			encodedSource,
			Buffer.from("# coding: latin-1\ndef caf\xe9():\n    return 1\n", 'latin1'),
		);
		const encoded = childProcess.spawnSync(
			'python',
			['-I', '-c', pythonStackAnalysisHelper, encodedSource],
			{ encoding: 'utf8', windowsHide: true },
		);
		assert.equal(encoded.status, 0, encoded.stderr);
		assert.ok(parsePythonStackUsage(encoded.stdout)
			.some(record => record.qualifiedName === 'café'));

		const invalidSource = path.join(temporary, 'invalid.py');
		fs.writeFileSync(invalidSource, 'def broken(:\n    pass\n');
		const invalid = childProcess.spawnSync(
			'python',
			['-I', '-c', pythonStackAnalysisHelper, invalidSource],
			{ encoding: 'utf8', windowsHide: true },
		);
		assert.notEqual(invalid.status, 0);
		assert.match(invalid.stderr, /SyntaxError/);
		assert.equal(invalid.stdout, '');
	} finally {
		fs.rmSync(temporary, { recursive: true, force: true });
	}
});

test('Python stack renderer keeps VM-slot units explicit', () => {
	const source = path.resolve('/project/source.py');
	const raw = rawArtifact('stack-analysis', JSON.stringify({
		entries: [
			{ qualifiedName: '<module>', firstLine: 1, stackSize: 2, nesting: [] },
			{ qualifiedName: 'answer', firstLine: 2, stackSize: 7, nesting: [] },
		],
	}));
	const backend = new ToolchainBackend(profile('python'), toolchainDefinitions.python);
	const rendered = backend.renderArtifact(
		raw,
		defaultArtifactOptions.display,
		renderContext('python', source, 'value = 1\ndef answer():\n    return value'),
	);
	assert.equal(rendered.presentation, 'text');
	if (rendered.presentation !== 'text') {
		return;
	}
	assert.match(rendered.lines[0].text, /evaluation-stack slots/);
	const answer = rendered.lines.flatMap(line => line.annotations ?? [])
		.find(annotation => annotation.kind === 'stack-usage' && annotation.functionName === 'answer');
	assert.deepEqual(answer, {
		kind: 'stack-usage',
		functionName: 'answer',
		value: 7,
		unit: 'vm-slots',
		qualifier: 'vm',
	});
	assert.equal(rendered.metrics.largestFrameUnit, 'vm-slots');
	assert.equal(rendered.metrics.totalKnownFrame, 9);
});

test('Python stack JSON validation rejects unsafe or malformed records', () => {
	assert.throws(() => parsePythonStackUsage('not json'), /malformed JSON/);
	assert.throws(
		() => parsePythonStackUsage(JSON.stringify({
			entries: [{ qualifiedName: 'bad', firstLine: 0, stackSize: -1, nesting: [] }],
		})),
		/entry 1 is invalid/,
	);
});

function availability(kind: ToolchainKind): string {
	return resolveArtifactAvailability(profile(kind), 'stack-analysis').status;
}

function renderContext(
	kind: ToolchainKind,
	sourceFile: string,
	text: string,
): ArtifactRenderContext {
	return {
		backend: new ToolchainBackend(profile(kind), toolchainDefinitions[kind]),
		source: { uri: { fsPath: sourceFile } as never, text },
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
