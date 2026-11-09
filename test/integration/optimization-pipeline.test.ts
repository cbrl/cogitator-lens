/**
 * Prints the optimization pipeline of one function with real toolchains.
 *
 * Each test needs its compiler and skips when it is absent. The function name comes from the LLVM IR
 * of the source, or from the assembly for GCC, as in the function picker of Open Artifact.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { artifactDefinitions } from '../../src/artifacts/core/artifact-definitions.js';
import { renderOptimizationPipeline } from '../../src/artifacts/optimization-pipeline/pipeline-renderer.js';
import { detectVisualStudioToolchains } from '../../src/toolchains/visual-studio-detection.js';
import { toolchainDefinitions } from '../../src/toolchains/toolchain-map.js';
import {
	defaultArtifactOptions,
	type RawArtifact,
	type RenderedTextArtifact,
	type ToolchainKind,
} from '../../src/types/index.js';
import { renderContext } from '../support/artifacts.js';
import { commandExists } from '../support/environment.js';
import { declaredImplementation, neverCancelled, sourceUri, toolchainBackend } from '../support/toolchains.js';

const cSource = [
	'static int square(int v) { return v * v; }',
	'int sum_squares(const int *values, int count) {',
	'\tint total = 0;',
	'\tfor (int i = 0; i < count; ++i) total += square(values[i]);',
	'\treturn total;',
	'}',
	'int other_function(int v) { return v + 1; }',
	'',
].join('\n');

const rustSource = [
	'pub fn sum_squares(values: &[i32]) -> i32 {',
	'    values.iter().map(|v| v * v).sum()',
	'}',
	'pub fn other_function(v: i32) -> i32 {',
	'    v + 1',
	'}',
	'',
].join('\n');

/** The first command of a list that runs. */
function firstCommand(t: TestContext, commands: readonly string[]): string | undefined {
	const found = commands.find((command) => commandExists(command, '--version'));
	if (!found) {
		t.skip(`none of ${commands.join(', ')} is installed`);
	}
	return found;
}

async function visualStudioClangCl(t: TestContext): Promise<string | undefined> {
	const profile = (await detectVisualStudioToolchains(process.env, process.platform)).find(
		(candidate) => candidate.kind === 'clang-cl',
	);
	if (!profile) {
		t.skip('no Visual Studio clang-cl is installed');
	}
	return profile?.executable;
}

/**
 * Compiles the LLVM IR or the assembly, selects the function whose name has `sum_squares`, and prints
 * the pipeline of that function. Each pass must name that function only.
 */
async function pipelineOf(
	kind: ToolchainKind,
	executable: string,
	filename: string,
	text: string,
	args: readonly string[],
): Promise<RenderedTextArtifact> {
	const temporary = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'coglens-pipeline-'));
	try {
		const source = path.join(temporary, filename);
		await fs.promises.writeFile(source, text);
		const backend = toolchainBackend(kind, { executable });
		const options = { args, workingDirectory: temporary, productionOptions: defaultArtifactOptions.production };
		const produce = async (artifact: 'llvm-ir' | 'assembly' | 'optimization-pipeline', functionFilter?: string) => {
			const produced = await declaredImplementation(kind, artifact).producer(
				backend,
				sourceUri(source),
				{ ...options, ...(functionFilter ? { functionFilter } : {}) },
				neverCancelled,
			);
			return { ...produced, kind: artifact } satisfies RawArtifact;
		};

		const listingKind = toolchainDefinitions[kind].artifacts['llvm-ir'] ? 'llvm-ir' : 'assembly';
		const listing = await artifactDefinitions[listingKind].renderer(
			await produce(listingKind),
			defaultArtifactOptions.display,
			renderContext(backend),
		);
		const name =
			listing.presentation === 'text'
				? listing.symbols.find((symbol) => /sum_squares/u.test(symbol.name))?.name
				: undefined;
		assert.ok(name, `The ${listingKind} defines sum_squares`);

		const raw = await produce('optimization-pipeline', name);
		assert.ok(raw.text.length < 50 * 1024 * 1024, 'The pass dumps of one function stay under the output limit');
		const render = declaredImplementation(kind, 'optimization-pipeline').renderer ?? renderOptimizationPipeline;
		const pipeline = await render(
			raw,
			{ ...defaultArtifactOptions.display, showUnchangedPasses: true },
			renderContext(backend),
		);
		assert.ok(pipeline.presentation === 'text', 'The pipeline is a text listing');
		const passes = pipeline.passes ?? [];
		assert.ok(passes.length > 50, `${passes.length} passes`);
		assert.ok(passes.filter((pass) => pass.changed).length > 5, 'Several passes change the function');
		assert.ok(passes.filter((pass) => pass.machine).length > 10, 'The machine passes run too');
		for (const pass of passes.filter((candidate) => !candidate.machine)) {
			assert.doesNotMatch(pass.after, /other_function/u, `${pass.name} names one function only`);
		}
		return pipeline;
	} finally {
		await fs.promises.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
}

test('clang prints the optimization pipeline of one function', async (t) => {
	const clang = firstCommand(t, ['clang', 'clang-21', 'clang-20', 'clang-19', 'clang-18']);
	if (!clang) {
		return;
	}
	const pipeline = await pipelineOf('clang', clang, 'main.c', cSource, ['-O2']);
	assert.ok(pipeline.passes?.some((pass) => pass.changed && /^InstCombinePass on /u.test(pass.name)));
});

test('GCC prints the optimization pipeline of one function in C and C++', async (t) => {
	const gcc = firstCommand(t, ['gcc', 'gcc-16', 'gcc-15', 'gcc-14']);
	if (!gcc) {
		return;
	}
	for (const filename of ['main.c', 'main.cpp']) {
		const pipeline = await pipelineOf('gcc', gcc, filename, cSource, ['-O2']);
		const passes = pipeline.passes ?? [];
		const names = passes.map((pass) => pass.name);
		// The original and gimple dumps have no function headers, so the first pass comes after them.
		assert.ok(names[0]?.endsWith('(tree)'), filename);
		assert.ok(!names.includes('gimple (tree)'), filename);
		assert.ok(names.includes('optimized (tree)'), filename);
		assert.ok(names.includes('expand (rtl)'), filename);
		assert.ok(names.at(-1)?.endsWith('(rtl)'), filename);
		// The square function is inlined, so the optimized code has no call.
		const optimized = passes.find((pass) => pass.name === 'optimized (tree)');
		assert.match(optimized?.after ?? '', /^int sum_squares \(/mu, filename);
		assert.doesNotMatch(optimized?.after ?? '', /square \(/u, filename);
		const expand = passes.find((pass) => pass.name === 'expand (rtl)');
		assert.match(expand?.after ?? '', /^\(note 1 0 /u, filename);
		assert.ok(passes.every((pass) => pass.extension === '.txt'));
	}
});

test('clang-cl prints the optimization pipeline of a function with an MSVC name', async (t) => {
	const clangCl = await visualStudioClangCl(t);
	if (!clangCl) {
		return;
	}
	const pipeline = await pipelineOf('clang-cl', clangCl, 'main.cpp', cSource, ['/O2']);
	assert.ok(pipeline.passes?.some((pass) => pass.name.includes('?sum_squares@@')));
});

test('rustc prints the optimization pipeline of one function', async (t) => {
	const rustc = firstCommand(t, ['rustc']);
	if (!rustc) {
		return;
	}
	await pipelineOf('rust', rustc, 'main.rs', rustSource, ['-O']);
});
