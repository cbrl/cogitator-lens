import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseGccOptimizationRemarks } from '../../src/artifacts/optimization-remarks/gcc-optimization-remarks.js';
import {
	parseGoOptimizationRemarks,
	renderGoOptimizationRemarks,
} from '../../src/artifacts/optimization-remarks/go-optimization-remarks.js';
import {
	msvcOptimizationRemarksOutput,
	parseMsvcOptimizationRemarks,
	renderMsvcOptimizationRemarks,
} from '../../src/artifacts/optimization-remarks/msvc-optimization-remarks.js';
import { parseRustOptimizationRemarks } from '../../src/artifacts/optimization-remarks/rust-optimization-remarks.js';
import { parseRustDiagnostics } from '../../src/toolchains/rust/diagnostics.js';
import { rustOptimizationRemarksOutput } from '../../src/toolchains/rust.js';
import { defaultArtifactOptions } from '../../src/types/index.js';
import { rawArtifact, renderContext } from '../support/artifacts.js';
import { fixturePath, readFixture } from '../support/environment.js';
import { declaredImplementation, neverCancelled, sourceUri, toolchainBackend } from '../support/toolchains.js';

test('GCC optimization info normalizes relative locations and pass families', () => {
	const project = path.resolve('/project');
	const remarks = parseGccOptimizationRemarks(readFixture('optimization-remarks', 'gcc.opt'), project);

	assert.deepEqual(
		remarks.map((remark) => ({ ...remark, file: path.relative(project, remark.file!) })),
		[
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
		],
	);
});

/** The name of a file in a path with either separator, so a Windows path also works on Linux. */
const fileName = (file: string | undefined) => file?.split(/[\\/]/u).at(-1);

test('rustc remark notes give the location, the pass, and the kind of each remark', () => {
	const read = (name: string) =>
		parseRustOptimizationRemarks(readFixture('optimization-remarks', name), path.resolve('/work'));
	const windows = read('rustc-windows.stderr.txt');
	const linux = read('rustc-linux.stderr.txt');
	for (const remarks of [windows, linux]) {
		assert.ok(!remarks.some((remark) => remark.pass === 'size-info'), 'The size-info remarks are left out');
		assert.equal(remarks.filter((remark) => remark.file === undefined).length, 6, 'No location: <unknown file>');
		const inline = remarks.find((remark) => remark.pass === 'inline');
		assert.deepEqual([fileName(inline?.file), inline?.line, inline?.category], ['remarks.rs', 22, 'missed']);
		assert.match(
			inline?.message ?? '',
			/^'\w*square\w*' not inlined into '\w*squares\w*' because it should never be inlined \(cost=never\): noinline function attribute$/u,
		);
		const vectorized = remarks.find((remark) => remark.pass === 'loop-vectorize' && remark.category === 'passed');
		// The loop of a slice iterator is in the library, so the remark is not on a line of the source.
		assert.equal(fileName(vectorized?.file), 'macros.rs');
		assert.match(vectorized?.message ?? '', /^vectorized loop \(vectorization width: 4, interleaved count: 2\)$/u);
		// The next lines of a long message have an indent.
		const frame = remarks.find((remark) => remark.pass === 'stack-frame-layout' && remark.line === 20);
		assert.match(
			frame?.message ?? '',
			/^Function: \w+ Offset: \[SP-8\], Type: Spill, Align: 16, Size: 8 Offset: /u,
		);
		assert.ok(remarks.some((remark) => /^BasicBlock: \w+: \d/u.test(remark.message)));
	}
	// rustc gives no columns on Windows.
	assert.deepEqual(
		[windows, linux].map((remarks) => remarks.find((remark) => remark.pass === 'inline')?.column),
		[undefined, 18],
	);
});

test('rustc diagnostics among the remark notes stay diagnostics, and the remarks do not', () => {
	const source = sourceUri(path.resolve('/work/remarks.rs'));
	const text = readFixture('optimization-remarks', 'rustc-linux.stderr.txt').replaceAll(
		'/work/remarks.rs',
		path.resolve('/work/remarks.rs'),
	);
	const diagnostics = parseRustDiagnostics(
		rustOptimizationRemarksOutput.outputDiagnostics?.(text) ?? '',
		source,
		path.resolve('/work'),
	);
	assert.deepEqual(diagnostics, [
		{ uri: source, line: 27, column: 8, severity: 'warning', message: 'unused variable: `unused`' },
	]);
});

/**
 * A rustc stand-in that prints the remark output of the fixture to its error output, with the path
 * of the source. It also writes the dependency file that the compile asks for.
 */
const fakeRustc = String.raw`
const fs = require('node:fs');
const args = process.argv.slice(2);
const source = args.at(-1);
const dependencies = args.find((arg) => arg.startsWith('--emit=dep-info='));
if (dependencies) {
	fs.writeFileSync(dependencies.slice('--emit=dep-info='.length), 'output.o: ' + source.replace(/([ \\])/g, '\\$1') + '\n');
}
process.stderr.write(fs.readFileSync(process.env.FAKE_STDERR, 'utf8').replaceAll('/work/remarks.rs', source));
`;

test('the backend reads the warnings of rustc from the stream of the remarks', async () => {
	const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'coglens-remarks-'));
	try {
		const script = path.join(directory, 'fake-rustc.cjs');
		const source = path.join(directory, 'remarks.rs');
		await fs.promises.writeFile(script, fakeRustc);
		await fs.promises.copyFile(fixturePath('optimization-remarks', 'remarks.rs'), source);
		const backend = toolchainBackend('rust', { executable: process.execPath, defaultArguments: [script] });
		const implementation = declaredImplementation('rust', 'optimization-remarks');
		const produced = await implementation.producer(
			backend,
			sourceUri(source),
			{
				args: [],
				env: { FAKE_STDERR: fixturePath('optimization-remarks', 'rustc-linux.stderr.txt') },
				workingDirectory: directory,
				productionOptions: defaultArtifactOptions.production,
			},
			neverCancelled,
		);
		assert.deepEqual(
			produced.diagnostics.map((diagnostic) => [diagnostic.uri.fsPath, diagnostic.line, diagnostic.message]),
			[[source, 27, 'unused variable: `unused`']],
		);
		const rendered = await implementation.renderer?.(
			{ ...produced, kind: 'optimization-remarks' },
			defaultArtifactOptions.display,
			renderContext(backend, { file: source, text: readFixture('optimization-remarks', 'remarks.rs') }),
		);
		assert.equal(rendered?.presentation, 'text');
		const inline =
			rendered?.presentation === 'text'
				? rendered.lines.find((line) => line.annotations?.[0].text.startsWith('[missed] inline: '))
				: undefined;
		// Column 18 of "        *value = square(*value);" is the call.
		assert.deepEqual([inline?.source?.line, inline?.source?.column], [22, 17]);
		// The remarks in the library, such as the vectorized loop of a slice iterator, are not shown.
		assert.deepEqual([rendered?.metrics.missedRemarkCount, rendered?.metrics.omittedRemarkCount], [6, 14]);
	} finally {
		await fs.promises.rm(directory, { recursive: true, force: true });
	}
});

test('Go 1.24 and 1.26 give the same inlining and escape remarks', () => {
	const read = (name: string) =>
		parseGoOptimizationRemarks(readFixture('optimization-remarks', name), path.resolve('/work'));
	const remarks = read('go-1.26.stderr.txt');
	assert.deepEqual(read('go-1.24.stderr.txt'), remarks, 'Only the explanations differ');
	assert.equal(remarks.length, 27);
	assert.ok(remarks.every((remark) => remark.file === path.resolve('/work/remarks.go')));
	const at = (line: number, column: number) =>
		remarks
			.filter((remark) => remark.line === line && remark.column === column)
			.map((remark) => `${remark.category} ${remark.pass}: ${remark.message}`);
	assert.deepEqual(at(7, 6), ['analysis inline: can inline add with cost 4']);
	assert.deepEqual(at(23, 6), [
		'missed inline: cannot inline complex: function too complex: cost 122 exceeds budget 80',
	]);
	assert.deepEqual(at(18, 14), ['passed inline: inlining call to add']);
	assert.deepEqual(at(12, 9), ['missed escape: &point{...} escapes to heap']);
	assert.deepEqual(at(15, 10), ['passed escape: values does not escape']);
	assert.deepEqual(at(50, 64), [
		'passed inline: inlining call to keep',
		'missed escape: ~r0 escapes to heap',
		'missed escape: make([]int, len(values)) escapes to heap',
	]);
	assert.ok(!remarks.some((remark) => /^\s|:$|flow:/u.test(remark.message)), 'No explanation line is a remark');
});

test('Go remarks of other kinds have their own pass, or are analysis remarks of the Go compiler', () => {
	const remarks = parseGoOptimizationRemarks(
		[
			'# example.com/m',
			'./main.go:4:6: leaking param: p',
			'./main.go:9:12: devirtualizing s.Area to *square',
			'./main.go:12:2: moved to heap: x',
			'./main.go:15:7: func literal does not escape',
			'./main.go:20:3: x capturing by value: x (addr=false assign=false width=8)',
		].join('\n'),
		path.resolve('/work'),
	);
	assert.deepEqual(
		remarks.map((remark) => `${remark.category} ${remark.pass}`),
		['analysis escape', 'passed devirtualize', 'missed escape', 'passed escape', 'analysis go'],
	);
});

test('cl.exe loop remarks give the vectorizer and parallelizer results with the reason text', () => {
	const read = (name: string) =>
		parseMsvcOptimizationRemarks(readFixture('optimization-remarks', name), 'C:\\work').map(
			({ file, ...remark }) => ({ file: fileName(file), ...remark }),
		);
	assert.deepEqual(read('msvc.stdout.txt'), [
		{
			file: 'remarks.cpp',
			line: 12,
			pass: 'vectorizer',
			category: 'missed',
			message:
				"loop not vectorized due to reason '502': Induction variable is stepped in some manner other than a simple +1.",
		},
		{
			file: 'remarks.cpp',
			line: 20,
			pass: 'vectorizer',
			category: 'missed',
			message:
				"loop not vectorized due to reason '1200': Loop contains loop-carried data dependencies that prevent vectorization.",
		},
		{ file: 'remarks.cpp', line: 5, pass: 'vectorizer', category: 'passed', message: 'loop vectorized' },
	]);
	const parallelizer = read('msvc-qpar.stdout.txt').filter((remark) => remark.pass === 'parallelizer');
	assert.deepEqual(
		parallelizer.map((remark) => [remark.line, remark.category, remark.message]),
		[
			[
				12,
				'missed',
				"loop not parallelized due to reason '502': Induction variable is stepped in some manner other than a simple +1.",
			],
			[
				20,
				'missed',
				"loop not parallelized due to reason '1000': The compiler detected a data dependency in the loop body.",
			],
			[5, 'missed', "loop not parallelized due to reason '1004': There's a scalar reduction in the loop body."],
		],
	);
	// A reason without a description and an unknown message keep their text.
	assert.deepEqual(
		parseMsvcOptimizationRemarks(
			[
				"C:\\work\\a.cpp(3) : info C5002: loop not vectorized due to reason '9999'",
				'C:\\work\\a.cpp(4) : info C5021: unable to associate loop with pragma',
			].join('\n'),
			'C:\\work',
		).map((remark) => [remark.pass, remark.category, remark.message]),
		[
			['vectorizer', 'missed', "loop not vectorized due to reason '9999'"],
			['loop', 'analysis', 'unable to associate loop with pragma'],
		],
	);
});

test('the diagnostics of cl.exe leave out the loop remarks', () => {
	const text = readFixture('optimization-remarks', 'msvc.stdout.txt');
	const lines = (msvcOptimizationRemarksOutput.outputDiagnostics?.(text) ?? '').split('\n');
	assert.ok(lines.includes("C:\\work\\remarks.cpp(19): warning C4101: 'unused': unreferenced local variable"));
	assert.ok(!lines.some((line) => /info C50/u.test(line)));
	assert.equal(lines.length, text.split('\n').length - 3, 'Only the three remark lines are left out');
});

test('Go and cl.exe remarks land on their source lines', () => {
	const work = path.resolve('/work');
	const render = (
		renderer: typeof renderGoOptimizationRemarks,
		toolchain: 'go' | 'msvc',
		name: string,
		output: string,
	) =>
		renderer(
			rawArtifact('optimization-remarks', output, {
				command: { executable: '', args: [], environmentVariableNames: [], cwd: work },
			}),
			defaultArtifactOptions.display,
			renderContext(toolchain, { file: path.join(work, name), text: readFixture('optimization-remarks', name) }),
		);
	const annotationsOf = (rendered: ReturnType<typeof render>, line: number) =>
		rendered.lines
			.filter((row) => row.text === '' && row.source?.line === line)
			.flatMap((row) => row.annotations ?? [])
			.map((annotation) => annotation.text);

	const go = render(
		renderGoOptimizationRemarks,
		'go',
		'remarks.go',
		readFixture('optimization-remarks', 'go-1.26.stderr.txt'),
	);
	assert.deepEqual(annotationsOf(go, 23), [
		'[missed] inline: cannot inline complex: function too complex: cost 122 exceeds budget 80',
		'[passed] escape: values does not escape',
	]);
	assert.deepEqual(
		[
			go.metrics.remarkCount,
			go.metrics.passedRemarkCount,
			go.metrics.missedRemarkCount,
			go.metrics.analysisRemarkCount,
		],
		[27, 13, 10, 4],
	);

	const cl = render(
		renderMsvcOptimizationRemarks,
		'msvc',
		'remarks.cpp',
		readFixture('optimization-remarks', 'msvc.stdout.txt').replaceAll('C:\\work\\', `${work}${path.sep}`),
	);
	assert.deepEqual(annotationsOf(cl, 5), ['[passed] vectorizer: loop vectorized']);
	assert.equal(cl.metrics.remarkCount, 3);
});
