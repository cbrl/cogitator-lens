import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
	clangClLlvmIrOutput,
	clangClOptimizationRecord,
	clangOptimizationRecord,
	gccOptimizationRecord,
	llvmIrOutput,
} from '../src/artifacts/compiler-output-producer.js';
import { artifactDefinitions } from '../src/artifacts/artifact-definitions.js';
import {
	parseGccOptimizationRemarks,
} from '../src/artifacts/optimization-remarks-renderer.js';
import {
	resolveArtifactAvailability,
	toolchainDefinitions,
} from '../src/toolchains/toolchain-map.js';
import { ToolchainBackend } from '../src/toolchains/toolchain-backend.js';
import {
	defaultArtifactOptions,
	type ArtifactKind,
	type ArtifactRenderContext,
	type RawArtifact,
	type ToolchainKind,
	type ToolchainProfile,
} from '../src/types/index.js';

test('compiler artifact availability matches implemented producers', () => {
	for (const kind of ['clang', 'apple-clang'] as const) {
		assert.equal(availability(kind, 'llvm-ir'), 'available');
		assert.equal(availability(kind, 'optimization-remarks'), 'available');
	}
	assert.equal(availability('gcc', 'optimization-remarks'), 'available');
	assert.equal(availability('gcc', 'llvm-ir'), 'unsupported');
	assert.equal(availability('clang-cl', 'llvm-ir'), 'available');
	assert.equal(availability('clang-cl', 'optimization-remarks'), 'available');
	assert.equal(availability('rust', 'llvm-ir'), 'available');
	for (const kind of ['msvc'] as const) {
		assert.equal(availability(kind, 'llvm-ir'), 'unsupported');
		assert.equal(availability(kind, 'optimization-remarks'), 'unsupported');
	}
});

test('Clang LLVM IR and optimization-record arguments own their output modes', () => {
	assert.deepEqual(llvmIrOutput.arguments('artifact.ll', '/temporary', []), [
		'-emit-llvm',
		'-S',
		'-gline-tables-only',
		'-o',
		'artifact.ll',
	]);
	assert.deepEqual(clangClLlvmIrOutput.arguments('C:\\temporary\\artifact.ll', '/temporary', []), [
		'/clang:-emit-llvm',
		'/clang:-S',
		'/clang:-gline-tables-only',
		'/clang:-o',
		'/clang:C:\\temporary\\artifact.ll',
	]);
	assert.deepEqual(
		clangClOptimizationRecord.arguments(
			'C:\\temporary\\artifact.opt.yaml',
			'C:\\temporary',
			[],
		),
		[
			'/c',
			'/clang:-fsave-optimization-record=yaml',
			'/clang:-foptimization-record-file=C:\\temporary\\artifact.opt.yaml',
			`/Fo${path.join('C:\\temporary', 'output.obj')}`,
		],
	);
	assert.deepEqual(
		clangOptimizationRecord.arguments('artifact.opt.yaml', '/temporary', []),
		[
			'-c',
			'-fsave-optimization-record=yaml',
			'-foptimization-record-file=artifact.opt.yaml',
			'-o',
			path.join('/temporary', 'output.o'),
		],
	);
	assert.deepEqual(gccOptimizationRecord.arguments('artifact.opt', '/temporary', []), [
		'-c',
		'-fopt-info-all=artifact.opt',
		'-o',
		path.join('/temporary', 'output.o'),
	]);
});

test('clang-cl artifact cells dispatch through their clang-compatible specifications', async () => {
	for (const [kind, expectedSpec] of [
		['llvm-ir', clangClLlvmIrOutput],
		['optimization-remarks', clangClOptimizationRecord],
	] as const) {
		const cell = toolchainDefinitions['clang-cl'].artifacts[kind];
		assert.equal(cell.status, 'available');
		if (cell.status !== 'available' || cell.outputs !== undefined) {
			continue;
		}
		let receivedSpec: unknown;
		const fakeBackend = {
			produceCompilerOutput: async (
				artifactKind: ArtifactKind,
				_source: unknown,
				_options: unknown,
				spec: unknown,
			) => {
				receivedSpec = spec;
				return rawArtifact(artifactKind, '');
			},
		};
		await cell.producer(
			fakeBackend as never,
			{} as never,
			{ productionOptions: defaultArtifactOptions.production },
			{} as never,
		);
		assert.equal(receivedSpec, expectedSpec);
	}
});

test('LLVM IR renderer resolves debug metadata into source links and function navigation', async () => {
	const raw = rawArtifact(
		'llvm-ir',
		fixture('test/fixtures/llvm-ir/debug.ll'),
	);
	const rendered = await artifactDefinitions['llvm-ir'].renderer(
		raw,
		defaultArtifactOptions.display,
		renderContext(backend('clang')),
	);
	const multiply = rendered.lines.find(line => line.text.includes('%mul ='));
	assert.deepEqual(multiply?.source, {
		file: path.resolve('/work/source.cpp'),
		line: 4,
		column: 11,
	});
	assert.ok(rendered.sourceLocations.some(location => location.sourceLine === 4));
	assert.deepEqual(rendered.symbols, [{ name: 'square', line: 3 }]);
	assert.deepEqual(rendered.folds, [{ startLine: 3, endLine: 7 }]);
	assert.equal(rendered.metrics.functionCount, 1);
});

test('GCC optimization info normalizes relative locations and pass families', () => {
	const remarks = parseGccOptimizationRemarks(
		fixture('test/fixtures/optimization-remarks/gcc.opt'),
		path.resolve('/project'),
	);
	assert.deepEqual(remarks.map(remark => ({
		...remark,
		file: path.relative(path.resolve('/project'), remark.file!),
	})), [
		{
			file: path.join('src', 'source.cpp'),
			line: 8,
			column: 3,
			pass: 'vectorizer',
			category: 'passed',
			message: 'loop vectorized using 16 byte vectors',
		},
		{
			file: path.join('src', 'source.cpp'),
			line: 14,
			column: 9,
			pass: 'inliner',
			category: 'missed',
			message: 'not inlining call to external',
		},
		{
			file: path.join('src', 'source.cpp'),
			line: 20,
			column: 2,
			pass: 'loop',
			category: 'analysis',
			message: 'loop turned into non-loop; it never loops',
		},
	]);
});

test('optimization renderer places each remark decoration on an empty row above its source', () => {
	const raw = rawArtifact(
		'optimization-remarks',
		fixture('test/fixtures/optimization-remarks/clang.opt.yaml'),
	);
	const sourceText = Array.from(
		{ length: 15 },
		(_, index) => `source line ${index + 1}`,
	).join('\n');
	const rendered = artifactDefinitions['optimization-remarks'].renderer(
		raw,
		defaultArtifactOptions.display,
		renderContext(backend('clang'), '/project/source.cpp', sourceText),
	);
	assert.equal(rendered.lines.length, 17);
	assert.equal(rendered.lines[7].text, '');
	assert.deepEqual(rendered.lines[7].annotations?.[0], {
		kind: 'optimization-remark',
		category: 'passed',
		message: 'loop-vectorize: vectorized loop (vectorization width: 4)',
	});
	assert.equal(rendered.lines[7].source?.line, 8);
	assert.equal(rendered.lines[7].source?.column, 2);
	assert.equal(rendered.lines[8].text, 'source line 8');
	assert.equal(rendered.lines[8].annotations, undefined);
	assert.equal(rendered.lines[14].text, '');
	const missed = rendered.lines[14].annotations?.[0];
	assert.equal(missed?.kind, 'optimization-remark');
	assert.match(missed?.kind === 'optimization-remark' ? missed.message : '', /inline: external will not be inlined/);
	assert.equal(rendered.lines[15].text, 'source line 14');
	assert.equal(rendered.metrics.remarkCount, 2);
	assert.equal(rendered.metrics.omittedRemarkCount, 0);
	assert.equal(rendered.metrics.passedRemarkCount, 1);
	assert.equal(rendered.metrics.missedRemarkCount, 1);
	assert.equal(rendered.metrics.analysisRemarkCount, 0);
});

test('optimization renderer omits foreign, locationless, and out-of-range remarks', () => {
	const raw = rawArtifact('optimization-remarks', [
		'/project/source.cpp:2:3: optimized: loop vectorized',
		'/project/header.h:1:1: missed: header call was not inlined',
		'/project/source.cpp:20:1: note: outside the source',
		'locationless compiler detail',
	].join('\n'));
	const rendered = artifactDefinitions['optimization-remarks'].renderer(
		raw,
		defaultArtifactOptions.display,
		renderContext(
			backend('gcc'),
			'/project/source.cpp',
			'first line\nsecond line\nthird line',
		),
	);

	assert.deepEqual(rendered.lines.map(line => line.text), [
		'first line',
		'',
		'second line',
		'third line',
	]);
	assert.deepEqual(rendered.lines[1].annotations, [{
		kind: 'optimization-remark',
		category: 'passed',
		message: 'vectorizer: loop vectorized',
	}]);
	assert.equal(rendered.metrics.remarkCount, 1);
	assert.equal(rendered.metrics.omittedRemarkCount, 3);
	assert.equal(rendered.metrics.passedRemarkCount, 1);
	assert.equal(rendered.metrics.missedRemarkCount, 0);
});

test('optimization renderer gives multiple remarks on one source line separate anchor rows', () => {
	const rendered = artifactDefinitions['optimization-remarks'].renderer(
		rawArtifact('optimization-remarks', [
			'/project/source.cpp:2:3: optimized: loop vectorized',
			'/project/source.cpp:2:7: missed: call was not inlined',
		].join('\n')),
		defaultArtifactOptions.display,
		renderContext(
			backend('gcc'),
			'/project/source.cpp',
			'first line\nsecond line',
		),
	);

	assert.deepEqual(rendered.lines.map(line => line.text), [
		'first line',
		'',
		'',
		'second line',
	]);
	assert.deepEqual(
		rendered.lines.slice(1, 3).map(line => {
			const annotation = line.annotations?.[0];
			return annotation?.kind === 'optimization-remark'
				? annotation.category
				: undefined;
		}),
		['passed', 'missed'],
	);
	assert.deepEqual(
		rendered.lines.slice(1, 3).map(line => line.source?.column),
		[2, 6],
	);
});

test('malformed LLVM IR and optimization records produce valid rendered artifacts', async () => {
	const ir = await artifactDefinitions['llvm-ir'].renderer(
		rawArtifact('llvm-ir', 'not llvm ir'),
		defaultArtifactOptions.display,
		renderContext(backend('clang')),
	);
	assert.equal(ir.lines.length, 1);
	assert.deepEqual(ir.sourceLocations, []);
	assert.deepEqual(ir.symbols, []);

	const remarks = artifactDefinitions['optimization-remarks'].renderer(
		rawArtifact('optimization-remarks', 'not optimization output'),
		defaultArtifactOptions.display,
		renderContext(backend('gcc'), '/project/source.cpp', 'int main() {}\n'),
	);
	assert.deepEqual(remarks.lines.map(line => line.text), [
		'int main() {}',
		'',
	]);
	assert.equal(remarks.metrics.remarkCount, 0);
	assert.equal(remarks.metrics.omittedRemarkCount, 1);
});

function availability(
	toolchainKind: ToolchainKind,
	artifactKind: ArtifactKind,
): ReturnType<typeof resolveArtifactAvailability>['status'] {
	return resolveArtifactAvailability(profile(toolchainKind), artifactKind).status;
}

function backend(kind: ToolchainKind): ToolchainBackend {
	return new ToolchainBackend(profile(kind), toolchainDefinitions[kind]);
}

function renderContext(
	toolchain: ToolchainBackend,
	sourceFile = '/project/source.cpp',
	text = '',
): ArtifactRenderContext {
	return {
		backend: toolchain,
		source: {
			uri: { fsPath: path.normalize(sourceFile) } as never,
			text,
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
			workingDirectory: path.resolve('/work'),
		},
		truncated: false,
		inputs: [],
		dependencyCoverage: 'source-only',
	};
}

function fixture(filename: string): string {
	return fs.readFileSync(filename, 'utf8');
}
