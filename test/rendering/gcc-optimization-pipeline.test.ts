import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
	collectGccFunctionDumps,
	parseGccPipeline,
	renderGccOptimizationPipeline,
} from '../../src/artifacts/optimization-pipeline/gcc-pipeline.js';
import { currentProcessLimits, ExecError, setProcessLimits } from '../../src/exec.js';
import { defaultArtifactOptions } from '../../src/types/index.js';
import { rawArtifact, renderContext } from '../support/artifacts.js';
import { fixturePath } from '../support/environment.js';
import { declaredImplementation, neverCancelled, sourceUri, toolchainBackend } from '../support/toolchains.js';

/** The dumps of GCC 15.2 at -O2 for pipeline.c: a part of the tree, IPA, and RTL passes. */
const fixtures = fixturePath('optimization-pipeline', 'gcc-15');

function readFixtureDump(file: string): Promise<string> {
	return fs.promises.readFile(path.join(fixtures, file), 'utf8');
}

async function collectFixtures(assemblerName: string): Promise<string> {
	// The collector orders the dumps by their pass numbers, not by the order of the files.
	const files = (await fs.promises.readdir(fixtures)).reverse();
	return collectGccFunctionDumps(files, readFixtureDump, assemblerName);
}

test('the GCC collector keeps the code of one function from each dump, in the order of the passes', async () => {
	const text = await collectFixtures('clamp');
	const lines = text.split('\n');
	assert.deepEqual(
		lines.filter((line) => line.startsWith(';;;;')),
		[
			';;;; Function clamp',
			// The original and gimple dumps have no function headers, and the cgraph dump has no sections.
			';;;; Pass 010t.omplower',
			';;;; Pass 023t.ssa',
			';;;; Pass 024t.walloca1 (unchanged)',
			';;;; Pass 036t.ccp1',
			';;;; Pass 087i.cp',
			';;;; Pass 090i.inline (unchanged)',
			';;;; Pass 270t.optimized (unchanged)',
			';;;; Pass 271r.expand',
			';;;; Pass 306r.combine',
			';;;; Pass 364r.final',
		],
	);
	// The notes and the data flow of each pass are not code.
	for (const note of [
		'Removing basic block',
		'Modification phase',
		'Dataflow summary',
		'insn_cost',
		'\n;; Function',
	]) {
		assert.ok(!text.includes(note), note);
	}
	assert.ok(!text.includes('sum_of_squares'), 'The text holds one function only');
	assert.equal(lines[lines.indexOf(';;;; Pass 036t.ccp1') + 1], 'int clamp (int value, int low, int high)');
	assert.equal(lines[lines.indexOf(';;;; Pass 271r.expand') + 1], '(note 1 0 7 NOTE_INSN_DELETED)');
	assert.equal(lines[lines.indexOf(';;;; Pass 306r.combine') + 1], '(note 7 0 29 2 [bb 2] NOTE_INSN_BASIC_BLOCK)');
});

test('the GCC pipeline gives each pass the code before and after it', async () => {
	const pipeline = parseGccPipeline(await collectFixtures('clamp'));
	assert.equal(pipeline.functionName, 'clamp');
	assert.deepEqual(
		pipeline.passes.map((pass) => [pass.name, pass.machine, pass.before === pass.after]),
		[
			['omplower (tree)', false, false],
			['ssa (tree)', false, false],
			['walloca1 (tree)', false, true],
			['ccp1 (tree)', false, false],
			['cp (ipa)', false, false],
			['inline (ipa)', false, true],
			['optimized (tree)', false, true],
			['expand (rtl)', true, false],
			['combine (rtl)', true, false],
			['final (rtl)', true, false],
		],
	);
	const [omplower, ssa, , ccp1, , , optimized, expand] = pipeline.passes;
	assert.equal(omplower.before, '', 'The first pass starts from no code');
	assert.equal(ccp1.before, ssa.after);
	assert.match(ccp1.before, /_7 = low_3\(D\);/u);
	assert.doesNotMatch(ccp1.after, /_7 = low_3\(D\);/u);
	assert.match(optimized.after, /MIN_EXPR/u);
	assert.ok(optimized.after.endsWith('}'));
	assert.equal(expand.before, optimized.after, 'The expand pass shows the change from GIMPLE to RTL');
	assert.ok(pipeline.passes.every((pass) => pass.extension === '.txt'));
});

test('the GCC pipeline lists the passes that changed the function', async () => {
	const raw = rawArtifact('optimization-pipeline', await collectFixtures('sum_of_squares'));
	const display = { ...defaultArtifactOptions.display, showUnchangedPasses: true };
	const rendered = renderGccOptimizationPipeline(raw, display, renderContext('gcc'));
	const text = rendered.lines.map((line) => line.text);
	assert.equal(text[0], '; Optimization pipeline of sum_of_squares');
	assert.match(text[1], /^; 10 passes ran\. 8 passes changed the function, and a \* marks each of them\./u);
	assert.deepEqual(text.slice(4, 7), [' 1 * omplower (tree)', ' 2 * ssa (tree)', ' 3   walloca1 (tree)']);
	assert.equal(text.at(-1), '10 * final (rtl)', 'No suffix follows an RTL pass');
	assert.deepEqual(rendered.metrics, { passCount: 10, changedPassCount: 8, machinePassCount: 3 });
});

test('the GCC collector finds a cold part, a name with one more underscore, and no function', async () => {
	const section = ';; Function f (f, funcdef_no=0, decl_uid=1, cgraph_uid=1, symbol_order=0) (executed once)\r\n';
	const dump = `${section}\r\nNote of the pass\r\nint f ()\r\n{\r\n  return 1;\r\n}\r\n\r\n`;
	const collect = (name: string) => collectGccFunctionDumps(['a.c.010t.lower', 'a.o'], async () => dump, name);
	const expected = [';;;; Function f', ';;;; Pass 010t.lower', 'int f ()', '{', '  return 1;', '}'].join('\n');
	assert.equal(await collect('f'), expected);
	assert.equal(await collect('f.cold'), expected);
	assert.equal(await collect('_f'), expected);
	const missing = await collect('g');
	assert.equal(missing, ';;;; Function g');
	const rendered = renderGccOptimizationPipeline(
		rawArtifact('optimization-pipeline', missing),
		defaultArtifactOptions.display,
		renderContext('gcc'),
	);
	assert.equal(rendered.lines[0].text, '; The compiler printed no passes for g.');
});

test('the GCC collector keeps the code of a dump that has no expected form', async () => {
	const dump = [
		';; Function f (f, funcdef_no=0, decl_uid=1, cgraph_uid=1, symbol_order=0)',
		'',
		'a note',
		'',
		';; Function g (g, funcdef_no=1, decl_uid=2, cgraph_uid=2, symbol_order=1)',
		'(insn 1 0 0 2 (const_int 0))',
	].join('\n');
	const text = await collectGccFunctionDumps(['a.c.300r.x', 'a.c.020t.y'], async () => dump, 'f');
	assert.equal(text, [';;;; Function f', ';;;; Pass 020t.y', 'a note', ';;;; Pass 300r.x (unchanged)'].join('\n'));
});

/**
 * A GCC stand-in that records its arguments, writes the dependency file, and copies the dumps of
 * FAKE_DUMPS to the directory of its output file. FAKE_FILLER adds a file of that many bytes.
 */
const fakeGcc = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_ARGUMENTS, JSON.stringify(args) + '\n');
const dependencies = args.indexOf('-MF');
if (dependencies >= 0) {
	fs.writeFileSync(args[dependencies + 1], 'output.o: ' + args.at(-1).replace(/([ \\])/g, '\\$1') + '\n');
}
const directory = path.dirname(args[args.indexOf('-o') + 1]);
for (const file of fs.readdirSync(process.env.FAKE_DUMPS)) {
	if (file.startsWith('output.c.')) {
		fs.copyFileSync(path.join(process.env.FAKE_DUMPS, file), path.join(directory, file));
	}
}
if (process.env.FAKE_FILLER) {
	fs.writeFileSync(path.join(directory, 'filler'), 'x'.repeat(Number(process.env.FAKE_FILLER)));
}
process.stderr.write('pipeline.c:3:5: warning: a warning [-Wexample]\n');
`;

test('the GCC producer dumps each pass to a directory and reads one function from it', async (t) => {
	const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'coglens-gcc-pipeline-'));
	const limits = currentProcessLimits();
	t.after(async () => {
		setProcessLimits(limits);
		await fs.promises.rm(directory, { recursive: true, force: true });
	});
	const script = path.join(directory, 'fake-gcc.cjs');
	const recorded = path.join(directory, 'arguments.json');
	const source = path.join(directory, 'pipeline.c');
	await fs.promises.writeFile(script, fakeGcc);
	await fs.promises.copyFile(path.join(fixtures, 'pipeline.c'), source);
	const backend = toolchainBackend('gcc', { executable: process.execPath, defaultArguments: [script] });
	const { producer } = declaredImplementation('gcc', 'optimization-pipeline');
	const options = (filler = 0, dumps = fixtures) => ({
		args: ['-O2'],
		env: { FAKE_ARGUMENTS: recorded, FAKE_DUMPS: dumps, ...(filler ? { FAKE_FILLER: String(filler) } : {}) },
		workingDirectory: directory,
		productionOptions: defaultArtifactOptions.production,
	});

	await assert.rejects(producer(backend, sourceUri(source), options(), neverCancelled), /select a function/u);
	const produced = await producer(
		backend,
		sourceUri(source),
		{ ...options(), functionFilter: 'clamp' },
		neverCancelled,
	);
	assert.equal(produced.text, await collectFixtures('clamp'));
	assert.deepEqual(
		produced.diagnostics.map((diagnostic) => diagnostic.message),
		['a warning [-Wexample]'],
		'The diagnostics come from the error output',
	);
	const runs = (await fs.promises.readFile(recorded, 'utf8')).trim().split('\n');
	assert.equal(runs.length, 1, 'The compile lists its inputs, so no second run starts');
	const args: string[] = JSON.parse(runs[0]);
	const output = args[args.indexOf('-o') + 1];
	assert.equal(path.basename(output), 'output.o');
	assert.equal(args[args.indexOf('-dumpdir') + 1], path.dirname(output) + path.sep);
	for (const option of ['-O2', '-c', '-fdump-tree-all', '-fdump-ipa-all', '-fdump-rtl-all']) {
		assert.ok(args.includes(option), option);
	}

	// The dump files can use 20 times the output limit. The fixtures have about 58 KB.
	setProcessLimits({ ...limits, maxOutputBytes: 10_000 });
	await assert.rejects(
		producer(backend, sourceUri(source), { ...options(250_000), functionFilter: 'clamp' }, neverCancelled),
		(error: unknown) =>
			error instanceof ExecError && error.kind === 'output-limit' && /output files/u.test(error.message),
	);
	// The code of one function has the output limit: four dumps of 4 KB each are 16 KB of code.
	const large = path.join(directory, 'large');
	await fs.promises.mkdir(large);
	for (const pass of ['010t.a', '011t.b', '012t.c', '013t.d']) {
		const header = ';; Function f (f, funcdef_no=0, decl_uid=1, cgraph_uid=1, symbol_order=0)';
		const body = `  return ${pass};\n`.repeat(4_000 / 16);
		await fs.promises.writeFile(path.join(large, `output.c.${pass}`), `${header}\n\nint f ()\n{\n${body}}\n`);
	}
	setProcessLimits({ ...limits, maxOutputBytes: 10_000 });
	await assert.rejects(
		producer(backend, sourceUri(source), { ...options(0, large), functionFilter: 'f' }, neverCancelled),
		(error: unknown) =>
			error instanceof ExecError && error.kind === 'output-limit' && /of output\./u.test(error.message),
	);
	setProcessLimits({ ...limits, maxOutputBytes: 20_000 });
	const code = await producer(
		backend,
		sourceUri(source),
		{ ...options(0, large), functionFilter: 'f' },
		neverCancelled,
	);
	assert.equal(parseGccPipeline(code.text).passes.length, 4);
});
