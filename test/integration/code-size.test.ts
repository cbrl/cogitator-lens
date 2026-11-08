/**
 * Lists the code size of real compiled objects.
 *
 * Each test needs its compiler and the disassembler that the toolchain finds. It skips when one of
 * them is absent.
 */
import assert from 'node:assert/strict';
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

const cppSource = [
	'static int square(int v) { return v * v; }',
	'int sum_squares(const int *values, int count) {',
	'\tint total = 0;',
	'\tfor (int i = 0; i < count; ++i) total += square(values[i]);',
	'\treturn total;',
	'}',
	'int counter = 3;',
	'int other_function(int v) { return v + counter; }',
	'',
].join('\n');

function firstCommand(t: TestContext, commands: readonly string[]): string | undefined {
	const found = commands.find((command) => commandExists(command, '--version'));
	if (!found) {
		t.skip(`none of ${commands.join(', ')} is installed`);
	}
	return found;
}

async function codeSize(
	t: TestContext,
	kind: ToolchainKind,
	executable: string,
	args: readonly string[],
	demangle: boolean,
	tools = toolchainDefinitions[kind].discoverTools?.(executable) ?? {},
): Promise<RenderedTextArtifact | undefined> {
	if (!tools.disassembler || (demangle && !tools.demangler)) {
		t.skip(`the disassembler or the demangler of ${executable} was not found`);
		return undefined;
	}
	const temporary = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'coglens-size-'));
	try {
		const source = path.join(temporary, 'main.cpp');
		await fs.promises.writeFile(source, cppSource);
		const backend = toolchainBackend(kind, { executable, tools });
		const produced = await declaredImplementation(kind, 'code-size').producer(
			backend,
			sourceUri(source),
			{
				args,
				workingDirectory: temporary,
				productionOptions: { ...defaultArtifactOptions.production, demangle },
			},
			neverCancelled,
		);
		const rendered = await artifactDefinitions['code-size'].renderer(
			{ ...produced, kind: 'code-size' },
			defaultArtifactOptions.display,
			renderContext(backend, { file: source }),
		);
		assert.equal(rendered.presentation, 'text');
		const text = rendered.lines.map((line) => line.text).join('\n');
		assert.match(text, /^; Code size of main\.cpp: \d+ functions, \d+ bytes of instructions\.$/mu);
		const names = rendered.symbols.map((symbol) => symbol.name);
		const sumSquares = demangle ? 'sum_squares(int const*, int)' : undefined;
		assert.ok(
			names.some((name) => (sumSquares ? name === sumSquares : name.includes('sum_squares'))),
			`The functions: ${names.join(', ')}`,
		);
		assert.match(text, /^\s+\d+ {2}\.text$/mu, 'The section table lists the code section');
		const sized = rendered.lines.filter((line) => line.source);
		assert.ok(sized.length > 0, 'A function row maps to its source line');
		return rendered;
	} finally {
		await fs.promises.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
}

test('GNU objdump gives the code size of a GCC object', async (t) => {
	const gcc = firstCommand(t, ['g++', 'g++-14', 'g++-13']);
	if (gcc) {
		await codeSize(t, 'gcc', gcc, ['-O2', '-g'], false);
		await codeSize(t, 'gcc', gcc, ['-O2', '-g'], true);
	}
});

test('llvm-objdump gives the code size of a clang object', async (t) => {
	const clang = firstCommand(t, ['clang++', 'clang++-21', 'clang++-20', 'clang++-19']);
	if (clang) {
		await codeSize(t, 'clang', clang, ['-O2'], true);
	}
});

test('llvm-objdump and dumpbin give the code size of a Visual Studio object', async (t) => {
	const profiles = await detectVisualStudioToolchains(process.env, process.platform);
	const clangCl = profiles.find((candidate) => candidate.kind === 'clang-cl');
	const msvc = profiles.find((candidate) => candidate.kind === 'msvc');
	if (!clangCl || !msvc) {
		t.skip('no Visual Studio clang-cl and cl.exe are installed');
		return;
	}
	// llvm-cxxfilt does not demangle MSVC names, so the names stay mangled.
	await codeSize(t, 'clang-cl', clangCl.executable, ['/O2', '/Z7'], false);
	await codeSize(t, 'msvc', msvc.executable, ['/O2', '/Z7'], false, msvc.tools);
});
