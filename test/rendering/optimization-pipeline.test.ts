import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
	parsePipelinePasses,
	renderOptimizationPipeline,
} from '../../src/artifacts/optimization-pipeline/pipeline-renderer.js';
import {
	clangClPipelineArguments,
	clangPipelineArguments,
	llvmPassDumpOptions,
	pipelineProducer,
} from '../../src/artifacts/optimization-pipeline/pipeline-producer.js';
import { defaultArtifactOptions, type DisplayOptions } from '../../src/types/index.js';
import { rawArtifact, renderContext } from '../support/artifacts.js';
import { declaredImplementation, neverCancelled, sourceUri, toolchainBackend } from '../support/toolchains.js';

/**
 * The pass dumps of one function, in the form of clang 21 with `-filter-print-funcs`: a module pass
 * that changes nothing, a function pass that changes the function, and two machine passes.
 */
function passDump(name: string): string {
	const irName = /^[\w.$]+$/u.test(name) ? name : `"${name}"`;
	const define = `define dso_local noundef i32 @${irName}(i32 noundef %0) #0 {`;
	const before = [define, '  %2 = alloca i32, align 4', '  store i32 %0, ptr %2, align 4', '  ret i32 %0', '}'];
	const after = [define, '  ret i32 %0', '}'];
	return [
		'warning: an unused argument',
		'; *** IR Dump Before AlwaysInlinerPass on [module] ***',
		'; Function Attrs: mustprogress noinline',
		...before,
		'; *** IR Dump After AlwaysInlinerPass on [module] ***',
		...before,
		`; *** IR Dump Before SROAPass on ${name} ***`,
		...before,
		`; *** IR Dump After SROAPass on ${name} ***`,
		...after,
		'# *** IR Dump Before X86 DAG->DAG Instruction Selection (x86-isel) ***:',
		`# Machine code for function ${name}: IsSSA, TracksLiveness`,
		'',
		`# End machine code for function ${name}.`,
		'',
		'# *** IR Dump After X86 DAG->DAG Instruction Selection (x86-isel) ***:',
		`# Machine code for function ${name}: IsSSA, TracksLiveness`,
		'bb.0 (%ir-block.1):',
		'  $eax = COPY $edi',
		'  RET 0, $eax',
		'',
		`# End machine code for function ${name}.`,
		'',
		'# *** IR Dump Before Fixup Statepoint Caller Saved (fixup-statepoint-caller-saved) ***:',
		`# Machine code for function ${name}: IsSSA, TracksLiveness`,
		'bb.0 (%ir-block.1):',
		'  $eax = COPY $edi',
		'  RET 0, $eax',
		'',
		`# End machine code for function ${name}.`,
		'',
		'# *** IR Dump After Fixup Statepoint Caller Saved (fixup-statepoint-caller-saved) ***:',
		`# Machine code for function ${name}: IsSSA, TracksLiveness`,
		'bb.0 (%ir-block.1):',
		'  $eax = COPY $edi',
		'  RET 0, $eax',
		'',
		`# End machine code for function ${name}.`,
		'',
	].join('\n');
}

const display = (overrides: Partial<DisplayOptions> = {}): DisplayOptions => ({
	...defaultArtifactOptions.display,
	...overrides,
});

function pipelineArtifact(text: string, args: readonly string[]) {
	return rawArtifact('optimization-pipeline', text, {
		command: { executable: 'clang', args, environmentVariableNames: [], cwd: path.resolve('/project') },
	});
}

test('the pipeline lists the passes that changed the function, and each keeps its text', () => {
	const raw = pipelineArtifact(passDump('_Z3fooi'), ['-mllvm', '-filter-print-funcs=_Z3fooi']);
	const rendered = renderOptimizationPipeline(raw, display(), renderContext('clang'));
	const text = rendered.lines.map((line) => line.text);
	assert.equal(text[0], '; Optimization pipeline of _Z3fooi');
	assert.match(text[1], /4 passes ran\. 2 passes changed the function, and the list shows only them\./u);
	assert.deepEqual(text.slice(4), [
		'2 * SROAPass on _Z3fooi',
		'3 * X86 DAG->DAG Instruction Selection (x86-isel) (machine code)',
	]);
	assert.deepEqual(rendered.metrics, { passCount: 4, changedPassCount: 2, machinePassCount: 2 });

	const [sroa, isel] = rendered.passes ?? [];
	assert.deepEqual([sroa.line, sroa.number, sroa.machine, sroa.changed], [4, 2, false, true]);
	assert.match(sroa.before, /alloca/u);
	assert.doesNotMatch(sroa.after, /alloca/u);
	// The first machine pass compares with the IR after the last IR pass, so it shows the instruction selection.
	assert.equal(isel.before, sroa.after);
	assert.match(isel.after, /RET 0, \$eax/u);
});

test('the pipeline can list each pass, with a mark on each pass that changed the function', () => {
	const raw = pipelineArtifact(passDump('_Z3fooi'), ['-mllvm', '-filter-print-funcs=_Z3fooi']);
	const rendered = renderOptimizationPipeline(raw, display({ showUnchangedPasses: true }), renderContext('clang'));
	assert.match(rendered.lines[1].text, /and a \* marks each of them\./u);
	assert.deepEqual(
		rendered.lines.slice(4).map((line) => line.text),
		[
			'1   AlwaysInlinerPass on [module]',
			'2 * SROAPass on _Z3fooi',
			'3 * X86 DAG->DAG Instruction Selection (x86-isel) (machine code)',
			'4   Fixup Statepoint Caller Saved (fixup-statepoint-caller-saved) (machine code)',
		],
	);
	assert.deepEqual(
		rendered.passes?.map((pass) => [pass.line, pass.changed]),
		[
			[4, false],
			[5, true],
			[6, true],
			[7, false],
		],
	);
});

test('an MSVC name keeps its machine passes', () => {
	// The parser mode that splits the dumps by function cannot read a machine function named with ? and @.
	const passes = parsePipelinePasses(passDump('?foo@@YAHH@Z'));
	assert.deepEqual(
		passes.map((pass) => [pass.name, pass.machine]),
		[
			['AlwaysInlinerPass on [module]', false],
			['SROAPass on ?foo@@YAHH@Z', false],
			['X86 DAG->DAG Instruction Selection (x86-isel)', true],
			['Fixup Statepoint Caller Saved (fixup-statepoint-caller-saved)', true],
		],
	);
});

test('a blank line at the end of the output is no change of the last pass', () => {
	const define = 'define i32 @f(i32 %0) {';
	const dump = [
		'; *** IR Dump Before EarlyCSEPass on f ***',
		define,
		'  ret i32 %0',
		'}',
		'; *** IR Dump After EarlyCSEPass on f ***',
		define,
		'  ret i32 %0',
		'}',
		'',
	].join('\n');
	const rendered = renderOptimizationPipeline(
		pipelineArtifact(dump, ['-mllvm', '-filter-print-funcs=f']),
		display({ showUnchangedPasses: true }),
		renderContext('clang'),
	);
	assert.deepEqual(
		rendered.passes?.map((pass) => pass.changed),
		[false],
	);
	assert.equal(rendered.metrics.changedPassCount, 0);
});

test('output without pass dumps says that the compiler printed no passes', () => {
	const raw = pipelineArtifact('warning: an unused argument\n', [
		'-C',
		'llvm-args=-print-before-all -print-after-all -filter-print-funcs=_RNvCs1_4main3foo',
	]);
	const rendered = renderOptimizationPipeline(raw, display(), renderContext('rust'));
	assert.equal(rendered.lines[0].text, '; The compiler printed no passes for _RNvCs1_4main3foo.');
	assert.deepEqual(rendered.passes, []);
	assert.equal(rendered.metrics.passCount, 0);
});

test('each toolchain prints the passes of one function and writes its code', () => {
	assert.deepEqual(llvmPassDumpOptions('f'), ['-print-before-all', '-print-after-all', '-filter-print-funcs=f']);
	const temporary = path.resolve('/tmp/work');
	assert.deepEqual(clangPipelineArguments('f', temporary, []), [
		'-S',
		'-o',
		path.join(temporary, 'output.s'),
		'-mllvm',
		'-print-before-all',
		'-mllvm',
		'-print-after-all',
		'-mllvm',
		'-filter-print-funcs=f',
	]);
	assert.deepEqual(clangClPipelineArguments('?f@@YAXXZ', temporary, []).slice(0, 2), [
		'/c',
		`/Fo${path.join(temporary, 'output.obj')}`,
	]);
});

/**
 * A compiler stand-in that records its arguments, writes the dependency file, and prints a pass
 * dump of the filtered function to its error output.
 */
const fakeCompiler = String.raw`
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_ARGUMENTS, JSON.stringify(args) + '\n');
const dependencies = args.indexOf('-MF');
if (dependencies >= 0) {
	fs.writeFileSync(args[dependencies + 1], 'output.s: ' + args.at(-1).replace(/([ \\])/g, '\\$1') + '\n');
}
const filter = args.find((arg) => arg.startsWith('-filter-print-funcs='));
if (filter) {
	process.stderr.write(fs.readFileSync(process.env.FAKE_DUMP, 'utf8').replaceAll('NAME', filter.slice(filter.indexOf('=') + 1)));
}
`;

test('the producer reads the pass dumps of the selected function from the error output', async () => {
	const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'coglens-pipeline-'));
	try {
		const script = path.join(directory, 'fake-clang.cjs');
		const dump = path.join(directory, 'dump.txt');
		const recorded = path.join(directory, 'arguments.json');
		const source = path.join(directory, 'main.cpp');
		await fs.promises.writeFile(script, fakeCompiler);
		await fs.promises.writeFile(dump, passDump('NAME'));
		await fs.promises.writeFile(source, 'int foo(int v) { return v; }\n');
		const backend = toolchainBackend('clang', { executable: process.execPath, defaultArguments: [script] });
		const { producer } = declaredImplementation('clang', 'optimization-pipeline');
		const options = {
			args: ['-O2'],
			env: { FAKE_ARGUMENTS: recorded, FAKE_DUMP: dump },
			workingDirectory: directory,
			productionOptions: defaultArtifactOptions.production,
		};

		await assert.rejects(producer(backend, sourceUri(source), options, neverCancelled), /select a function/u);
		const produced = await producer(
			backend,
			sourceUri(source),
			{ ...options, functionFilter: '_Z3fooi' },
			neverCancelled,
		);
		const runs = (await fs.promises.readFile(recorded, 'utf8')).trim().split('\n');
		assert.equal(runs.length, 1, 'The compile lists its inputs, so no second run starts');
		const args: string[] = JSON.parse(runs[0]);
		assert.ok(args.includes('-O2'));
		assert.ok(args.includes('-filter-print-funcs=_Z3fooi'), runs[0]);
		assert.equal(parsePipelinePasses(produced.text).length, 4);
		assert.match(produced.text, /SROAPass on _Z3fooi/u);
	} finally {
		await fs.promises.rm(directory, { recursive: true, force: true });
	}
});

test('a pipeline producer without a filter asks for a function', async () => {
	const producer = pipelineProducer(() => []);
	await assert.rejects(
		producer(
			toolchainBackend('clang'),
			sourceUri('/project/main.cpp'),
			{
				productionOptions: defaultArtifactOptions.production,
			},
			neverCancelled,
		),
		/Run "Open Artifact" again to select a function\./u,
	);
});
