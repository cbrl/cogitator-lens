/**
 * Runs llvm-mca on the assembly of real toolchains.
 *
 * Each test needs its compiler and an llvm-mca that the toolchain finds, beside the compiler or on
 * the PATH. It skips when one of them is absent.
 */
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { artifactDefinitions } from '../../src/artifacts/core/artifact-definitions.js';
import { toolchainDefinitions } from '../../src/toolchains/toolchain-map.js';
import { detectVisualStudioToolchains } from '../../src/toolchains/visual-studio-detection.js';
import { defaultArtifactOptions, type RenderedTextArtifact, type ToolchainKind } from '../../src/types/index.js';
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
	'int counter = 3;',
	'int other_function(int v) { return v + counter; }',
	'int dense(int value, int other) {',
	'\tswitch (value) {',
	'\tcase 0: return other * 3;',
	'\tcase 1: return other + 7;',
	'\tcase 2: return other << 2;',
	'\tcase 3: return other ^ 5;',
	'\tcase 4: return other - 9;',
	'\tcase 5: return other / 3;',
	'\tdefault: return other;',
	'\t}',
	'}',
	'',
].join('\n');

/** The text of the report of one region, from its title to the title of the next region. */
function regionReport(rendered: RenderedTextArtifact | undefined, name: string): string {
	const text = rendered?.lines.map((line) => line.text).join('\n') ?? '';
	return text.split(/^\[\d+\] Code Region - /mu).find((part) => part.startsWith(`${name}\n`)) ?? '';
}

function firstCommand(t: TestContext, commands: readonly string[]): string | undefined {
	const found = commands.find((command) => commandExists(command, '--version'));
	if (!found) {
		t.skip(`none of ${commands.join(', ')} is installed`);
	}
	return found;
}

/** Analyzes the source with the llvm-mca that the toolchain finds, or skips without one. */
async function analyze(
	t: TestContext,
	kind: ToolchainKind,
	executable: string,
	filename: string,
	args: readonly string[],
): Promise<RenderedTextArtifact | undefined> {
	const tools = toolchainDefinitions[kind].discoverTools?.(executable) ?? {};
	if (!tools.analyzer) {
		t.skip(`no llvm-mca is beside ${executable} or on the PATH`);
		return undefined;
	}
	const temporary = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'coglens-mca-'));
	try {
		const source = path.join(temporary, filename);
		await fs.promises.writeFile(source, cSource);
		const backend = toolchainBackend(kind, { executable, tools });
		const produced = await declaredImplementation(kind, 'machine-code-analysis').producer(
			backend,
			sourceUri(source),
			{ args, workingDirectory: temporary, productionOptions: defaultArtifactOptions.production },
			neverCancelled,
		);
		const rendered = await artifactDefinitions['machine-code-analysis'].renderer(
			{ ...produced, kind: 'machine-code-analysis' },
			defaultArtifactOptions.display,
			renderContext(backend, { file: source }),
		);
		assert.equal(rendered.presentation, 'text');
		const names = rendered.symbols.map((symbol) => symbol.name);
		assert.ok(
			names.some((name) => name.includes('sum_squares')) && names.some((name) => name.includes('other_function')),
			`Each function is a region: ${names.join(', ')}`,
		);
		assert.ok(!names.some((name) => name.includes('counter')), 'A variable is no region');
		assert.match(rendered.lines.map((line) => line.text).join('\n'), /Block RThroughput:/u);
		return rendered;
	} finally {
		await fs.promises.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
}

/** The rows of the instruction tables map to the lines of the source. */
function assertMapped(rendered: RenderedTextArtifact | undefined, filename: string): void {
	const mapped = rendered?.lines.filter((line) => line.source) ?? [];
	assert.ok(rendered === undefined || mapped.length > 0, 'Some rows have a source line');
	assert.ok(mapped.every((line) => path.basename(line.source?.file ?? '') === filename));
	assert.ok(
		mapped.some((line) => line.source?.line === 4),
		'The loop of sum_squares on line 4 maps',
	);
}

test('llvm-mca analyzes each function of the clang assembly', async (t) => {
	const clang = firstCommand(t, ['clang', 'clang-21', 'clang-20', 'clang-19', 'clang-18']);
	if (clang) {
		assertMapped(await analyze(t, 'clang', clang, 'main.c', ['-O2']), 'main.c');
	}
});

test('llvm-mca analyzes each function of the GCC assembly', async (t) => {
	const gcc = firstCommand(t, ['gcc', 'gcc-14', 'gcc-13']);
	if (gcc) {
		const rendered = await analyze(t, 'gcc', gcc, 'main.c', ['-O2', '-g']);
		assertMapped(rendered, 'main.c');
		// GCC puts the jump table of the switch into .rodata, and the cases follow it.
		assert.ok(rendered === undefined || /xorl\s/u.test(regionReport(rendered, 'dense')), 'The cases are in dense');
	}
});

test('llvm-mca analyzes the 32-bit code of GCC -m32 with a 32-bit target', async (t) => {
	const gcc = firstCommand(t, ['gcc', 'gcc-14', 'gcc-13']);
	if (!gcc) {
		return;
	}
	const probe = childProcess.spawnSync(gcc, ['-m32', '-S', '-x', 'c', '-o', '-', '-'], {
		input: 'int f(void) { return 1; }\n',
		stdio: ['pipe', 'ignore', 'ignore'],
		windowsHide: true,
	});
	if (probe.status !== 0 || process.arch !== 'x64') {
		t.skip(`${gcc} does not compile 32-bit x86 code here`);
		return;
	}
	assertMapped(await analyze(t, 'gcc', gcc, 'main.c', ['-O2', '-g', '-m32']), 'main.c');
});

test('llvm-mca analyzes each function of the clang-cl assembly, also a leaf function', async (t) => {
	const profile = (await detectVisualStudioToolchains(process.env, process.platform)).find(
		(candidate) => candidate.kind === 'clang-cl',
	);
	if (!profile) {
		t.skip('no Visual Studio clang-cl is installed');
		return;
	}
	assertMapped(await analyze(t, 'clang-cl', profile.executable, 'main.cpp', ['/O2', '/Z7']), 'main.cpp');
});
