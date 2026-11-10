/**
 * Compiles unsaved text with real toolchains.
 *
 * Each test needs its compiler and skips when it is absent. The output must come from the unsaved
 * text, and it must name the saved source. No output may name the overlay file in the temporary
 * directory of the compile.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { sameLocalFile } from '../../src/file-identity.js';
import { ToolExitError } from '../../src/toolchains/toolchain-backend.js';
import { discoverDotNetTools } from '../../src/toolchains/dotnet.js';
import { findJavap } from '../../src/toolchains/java.js';
import { findExecutableOnPath } from '../../src/toolchains/path-detection.js';
import { renderJavaBytecode } from '../../src/artifacts/java/java-bytecode-renderer.js';
import { renderContext } from '../support/artifacts.js';
import { toolchainDefinitions } from '../../src/toolchains/toolchain-map.js';
import { detectVisualStudioToolchains } from '../../src/toolchains/visual-studio-detection.js';
import {
	defaultArtifactOptions,
	type ArtifactKind,
	type AuxiliaryTool,
	type ProducedArtifact,
	type ToolchainKind,
} from '../../src/types/index.js';
import { commandExists } from '../support/environment.js';
import {
	declaredImplementation,
	declaredOutput,
	neverCancelled,
	sourceUri,
	toolchainBackend,
} from '../support/toolchains.js';

const display = defaultArtifactOptions.display;

/** The folder of the overlay file in a path. */
const overlayFolder = /[\\/]overlay[\\/]/u;

const savedC = 'int saved_version(void) { return 1; }\n';
/** Line 4 has an unused variable, and line 7 is the body of the loop. */
const unsavedC = [
	'#include "local.h"',
	'',
	'int buffer_version(int n) {',
	'\tint unused;',
	'\tint total = 0;',
	'\tfor (int i = 0; i < n; i++)',
	'\t\ttotal += i * LOCAL_VALUE;',
	'\treturn total;',
	'}',
	'',
].join('\n');

interface UnsavedSource {
	readonly directory: string;
	readonly source: string;
	readonly header: string;
}

/** A source with saved text and a header beside it, in a folder whose name has a space. */
async function withUnsavedSource(
	filename: string,
	saved: string,
	test: (files: UnsavedSource) => Promise<void>,
): Promise<void> {
	const temporary = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'coglens-unsaved-'));
	const directory = path.join(temporary, 'real dir');
	try {
		await fs.promises.mkdir(directory);
		const source = path.join(directory, filename);
		const header = path.join(directory, 'local.h');
		await fs.promises.writeFile(source, saved);
		await fs.promises.writeFile(header, '#define LOCAL_VALUE 7\n');
		await test({ directory, source, header });
	} finally {
		await fs.promises.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
}

/** Runs the producer of an artifact with unsaved text in place of the source. */
async function produceUnsaved(
	kind: ToolchainKind,
	executable: string,
	artifact: ArtifactKind,
	files: UnsavedSource,
	text: string,
	{
		args = [],
		outputId,
		tools,
	}: { args?: readonly string[]; outputId?: string; tools?: Readonly<Record<string, AuxiliaryTool>> } = {},
): Promise<ProducedArtifact> {
	const backend = toolchainBackend(kind, { executable, ...(tools ? { tools } : {}) });
	const implementation = outputId ? declaredOutput(kind, artifact, outputId) : declaredImplementation(kind, artifact);
	return implementation.producer(
		backend,
		sourceUri(files.source),
		{
			args,
			workingDirectory: files.directory,
			productionOptions: defaultArtifactOptions.production,
			sourceOverlay: { text, byteOrderMark: false },
		},
		neverCancelled,
	);
}

/** The first command of a list that runs. */
function firstCommand(t: TestContext, commands: readonly string[], versionFlag = '--version'): string | undefined {
	const found = commands.find((command) => commandExists(command, versionFlag));
	if (!found) {
		t.skip(`none of ${commands.join(', ')} is installed`);
	}
	return found;
}

/** The output names no overlay file, and it comes from the unsaved text. */
function assertFromUnsavedText(produced: ProducedArtifact, marker: RegExp): void {
	assert.doesNotMatch(produced.text, overlayFolder);
	assert.match(produced.text, marker);
	assert.doesNotMatch(produced.text, /saved_version|SavedVersion/u);
}

/** The header is an input of the output, and the source is not, because its text is in the cache key. */
function assertHeaderInput(produced: ProducedArtifact, files: UnsavedSource): void {
	const inputs = produced.inputs.map((input) => fileURLToPath(input.uri));
	assert.ok(
		inputs.some((input) => sameLocalFile(input, files.header)),
		inputs.join('\n'),
	);
	assert.ok(!inputs.some((input) => sameLocalFile(input, files.source)), inputs.join('\n'));
	assert.ok(!inputs.some((input) => overlayFolder.test(input)), inputs.join('\n'));
}

/** The unused variable on line 4 gives a warning that names the source. */
function assertUnusedWarning(produced: ProducedArtifact, files: UnsavedSource): void {
	const warning = produced.diagnostics.find((diagnostic) => /unused|unreferenced/iu.test(diagnostic.message));
	assert.ok(warning, produced.diagnostics.map((diagnostic) => diagnostic.message).join('\n'));
	assert.ok(sameLocalFile(warning.uri.fsPath, files.source), warning.uri.fsPath);
	assert.equal(warning.line, 3);
}

/** The listing maps an instruction to line 7 of the unsaved text, the body of the loop. */
function assertLoopLineMapped(
	kind: ToolchainKind,
	executable: string,
	produced: ProducedArtifact,
	files: UnsavedSource,
): void {
	const parsed = toolchainBackend(kind, { executable }).parseAssembly(produced.text, display, {
		path: files.source,
		workingDirectory: produced.command.cwd,
	});
	const mapped = parsed.asm.filter(
		(line) => line.source?.file && sameLocalFile(path.resolve(files.directory, line.source.file), files.source),
	);
	assert.ok(
		mapped.some((line) => line.source?.line === 7),
		JSON.stringify(mapped.map((line) => line.source?.line)),
	);
}

test('GCC compiles unsaved text with a #line directive and the folder of the source', async (t) => {
	const gcc = firstCommand(t, ['gcc', 'gcc-16', 'gcc-15', 'gcc-14']);
	if (!gcc) {
		return;
	}
	await withUnsavedSource('main.c', savedC, async (files) => {
		const assembly = await produceUnsaved('gcc', gcc, 'assembly', files, unsavedC, { args: ['-Wall'] });
		assertFromUnsavedText(assembly, /buffer_version/u);
		assertHeaderInput(assembly, files);
		assertUnusedWarning(assembly, files);
		assertLoopLineMapped('gcc', gcc, assembly, files);

		const preprocessed = await produceUnsaved('gcc', gcc, 'preprocessed-source', files, unsavedC);
		assertFromUnsavedText(preprocessed, /i \* 7/u);
		for (const output of ['optimization-remarks', 'stack-analysis'] as const) {
			assert.doesNotMatch(
				(await produceUnsaved('gcc', gcc, output, files, unsavedC, { args: ['-O2'] })).text,
				overlayFolder,
			);
		}
	});
});

test('Clang compiles unsaved text through a VFS overlay', async (t) => {
	const clang = firstCommand(t, ['clang', 'clang-22', 'clang-21', 'clang-20', 'clang-19', 'clang-18']);
	if (!clang) {
		return;
	}
	await withUnsavedSource('main.c', savedC, async (files) => {
		const assembly = await produceUnsaved('clang', clang, 'assembly', files, unsavedC, { args: ['-Wall'] });
		assertFromUnsavedText(assembly, /buffer_version/u);
		assertHeaderInput(assembly, files);
		assertUnusedWarning(assembly, files);
		assertLoopLineMapped('clang', clang, assembly, files);

		for (const artifact of ['llvm-ir', 'ast', 'preprocessed-source'] as const) {
			assertFromUnsavedText(
				await produceUnsaved('clang', clang, artifact, files, unsavedC),
				/buffer_version|i \* 7/u,
			);
		}
	});
});

/** The Visual Studio compiler of a kind, or nothing when this computer has none. */
async function visualStudioCompiler(t: TestContext, kind: 'msvc' | 'clang-cl'): Promise<string | undefined> {
	const profile = (await detectVisualStudioToolchains(process.env, process.platform)).find(
		(candidate) => candidate.kind === kind,
	);
	if (!profile) {
		t.skip(`no Visual Studio ${kind} is installed`);
	}
	return profile?.executable;
}

test('cl.exe compiles unsaved text with a #line directive, /I, and a /FAc listing', async (t) => {
	const cl = await visualStudioCompiler(t, 'msvc');
	if (!cl) {
		return;
	}
	await withUnsavedSource('main.c', savedC, async (files) => {
		const assembly = await produceUnsaved('msvc', cl, 'assembly', files, unsavedC, { args: ['/W4'] });
		assertFromUnsavedText(assembly, /buffer_version/u);
		assert.match(assembly.text, /^; Line 7$/mu, 'A /FAc listing has a line comment for each source line');
		assertHeaderInput(assembly, files);
		assertUnusedWarning(assembly, files);
		assertLoopLineMapped('msvc', cl, assembly, files);
		assertFromUnsavedText(await produceUnsaved('msvc', cl, 'preprocessed-source', files, unsavedC), /i \* 7/u);
	});
});

test('clang-cl compiles unsaved text through a VFS overlay', async (t) => {
	const clangCl = await visualStudioCompiler(t, 'clang-cl');
	if (!clangCl) {
		return;
	}
	await withUnsavedSource('main.c', savedC, async (files) => {
		const assembly = await produceUnsaved('clang-cl', clangCl, 'assembly', files, unsavedC, { args: ['/W4'] });
		assertFromUnsavedText(assembly, /buffer_version/u);
		assertHeaderInput(assembly, files);
		assertUnusedWarning(assembly, files);
		assertLoopLineMapped('clang-cl', clangCl, assembly, files);
		assertFromUnsavedText(await produceUnsaved('clang-cl', clangCl, 'llvm-ir', files, unsavedC), /buffer_version/u);
	});
});

test('nvcc compiles unsaved text with a #line directive and -I', async (t) => {
	const nvcc = firstCommand(t, ['nvcc']);
	if (!nvcc) {
		return;
	}
	const kernel = [
		'#include "local.h"',
		'__global__ void buffer_kernel(int *out) {',
		'\tout[threadIdx.x] = threadIdx.x * LOCAL_VALUE;',
		'}',
		'',
	].join('\n');
	await withUnsavedSource('kernel.cu', '__global__ void saved_version(int *out) { out[0] = 1; }\n', async (files) => {
		let ptx: ProducedArtifact;
		try {
			ptx = await produceUnsaved('nvcc', nvcc, 'assembly', files, kernel);
		} catch (error) {
			// Each CUDA release accepts only some MSVC toolsets, and the headers of a newer one stop the compile.
			if (error instanceof ToolExitError && /STL1002|unsupported Microsoft Visual Studio/u.test(error.stdout)) {
				t.skip('nvcc does not support the default Visual Studio toolset of this host');
				return;
			}
			throw error;
		}
		assertFromUnsavedText(ptx, /buffer_kernel/u);
		const file = /^\s*\.file\s+\d+\s+"(.+)"/mu.exec(ptx.text)?.[1]?.replaceAll('\\\\', '\\');
		assert.ok(file && sameLocalFile(file, files.source), file);
	});
});

test('rustc compiles unsaved text from a temporary file with a path remap', async (t) => {
	const rustc = firstCommand(t, ['rustc']);
	if (!rustc) {
		return;
	}
	const text =
		'pub fn buffer_version(n: i32) -> i32 {\n    let mut total = 0;\n    for i in 0..n { total += i * 7; }\n    total\n}\n';
	await withUnsavedSource('lib.rs', 'pub fn saved_version() -> i32 { 1 }\n', async (files) => {
		const assembly = await produceUnsaved('rust', rustc, 'assembly', files, text);
		assertFromUnsavedText(assembly, /buffer_version/u);
		for (const artifact of ['llvm-ir', 'rust-mir'] as const) {
			assertFromUnsavedText(await produceUnsaved('rust', rustc, artifact, files, text), /buffer_version/u);
		}
		const warned = await produceUnsaved(
			'rust',
			rustc,
			'assembly',
			files,
			'pub fn buffer_version() { let unused = 1; }\n',
		);
		assert.ok(warned.diagnostics.some((diagnostic) => sameLocalFile(diagnostic.uri.fsPath, files.source)));
	});
});

test('Go compiles unsaved text through go build -overlay', async (t) => {
	const go = firstCommand(t, ['go'], 'version');
	if (!go) {
		return;
	}
	const text =
		'package main\n\nfunc bufferVersion(n int) int {\n\ttotal := 0\n\tfor i := 0; i < n; i++ {\n\t\ttotal += i * 7\n\t}\n\treturn total\n}\n\nfunc main() { println(bufferVersion(3)) }\n';
	await withUnsavedSource('main.go', 'package main\n\nfunc main() {}\n', async (files) => {
		const assembly = await produceUnsaved('go', go, 'assembly', files, text);
		assertFromUnsavedText(assembly, /main\.bufferVersion/u);
		const graph = await produceUnsaved('go', go, 'control-flow-graph', files, text, { outputId: 'go-ssa' });
		assert.doesNotMatch(graph.text, overlayFolder);
		assert.match(graph.text, /bufferVersion/u, 'GOSSAFUNC names a function of the unsaved text');

		// go build names the overlay file relative to the working folder.
		await assert.rejects(
			produceUnsaved('go', go, 'assembly', files, 'package main\n\nfunc main() { var unused int }\n'),
			(error: unknown) => {
				assert.ok(error instanceof ToolExitError);
				assert.doesNotMatch(error.stderr, overlayFolder);
				const diagnostics = toolchainDefinitions.go.parseDiagnostics(
					error.stderr,
					sourceUri(files.source),
					files.directory,
				);
				assert.ok(diagnostics.length > 0, error.stderr);
				assert.ok(diagnostics.every((diagnostic) => sameLocalFile(diagnostic.uri.fsPath, files.source)));
				return true;
			},
		);
	});
});

test('Python compiles unsaved text with the name of the source', async (t) => {
	const python = firstCommand(t, ['python', 'python3']);
	if (!python) {
		return;
	}
	const text =
		'def buffer_version(n):\n    total = 0\n    for i in range(n):\n        total += i * 7\n    def inner():\n        return total\n    return inner()\n';
	await withUnsavedSource('main.py', 'def saved_version():\n    return 1\n', async (files) => {
		const bytecode = await produceUnsaved('python', python, 'assembly', files, text);
		assertFromUnsavedText(bytecode, /buffer_version/u);
		assert.ok(bytecode.text.includes(`file "${files.source}"`), bytecode.text);
		assertFromUnsavedText(await produceUnsaved('python', python, 'ast', files, text), /buffer_version/u);
		assertFromUnsavedText(await produceUnsaved('python', python, 'stack-analysis', files, text), /buffer_version/u);
		const graph = await produceUnsaved('python', python, 'control-flow-graph', files, text, {
			outputId: 'python-bytecode',
		});
		assertFromUnsavedText(graph, /buffer_version/u);
	});
});

test('javac compiles unsaved text from a file with the name of the source', async (t) => {
	const javac = firstCommand(t, ['javac'], '-version');
	const javacPath = javac && (await findExecutableOnPath(javac));
	const javap = javacPath && findJavap(javacPath);
	if (!javacPath || !javap) {
		if (javacPath) {
			t.skip('javap was not found');
		}
		return;
	}
	/** Line 7 has a raw type, which -Xlint:rawtypes reports. */
	const text = [
		'public class Main {',
		'    static int bufferVersion(int n) {',
		'        int total = 0;',
		'        for (int i = 0; i < n; i++) total += i * Helper.VALUE;',
		'        return total;',
		'    }',
		'    static java.util.List raw() { return null; }',
		'}',
		'',
	].join('\n');
	await withUnsavedSource(
		'Main.java',
		'public class Main { static int SavedVersion() { return 1; } }\n',
		async (files) => {
			const helper = path.join(files.directory, 'Helper.java');
			await fs.promises.writeFile(helper, 'class Helper { static int VALUE = 7; }\n');
			const bytecode = await produceUnsaved('java', javacPath, 'assembly', files, text, {
				args: ['-Xlint:rawtypes'],
				tools: { javap: { executable: javap, inputMode: 'file-argument' } },
			});
			assertFromUnsavedText(bytecode, /bufferVersion/u);
			// The listing maps the loop body of the unsaved text.
			const rendered = renderJavaBytecode(
				{ ...bytecode, kind: 'assembly' },
				display,
				renderContext('java', { file: files.source }),
			);
			assert.ok(rendered.lines.some((line) => /: imul/u.test(line.text) && line.source?.line === 4));
			const inputs = bytecode.inputs.map((input) => fileURLToPath(input.uri));
			assert.ok(
				inputs.some((input) => sameLocalFile(input, helper)),
				inputs.join('\n'),
			);
			assert.ok(!inputs.some((input) => sameLocalFile(input, files.source) || overlayFolder.test(input)));
			const warning = bytecode.diagnostics.find((diagnostic) => /rawtypes/u.test(diagnostic.message));
			assert.ok(warning, bytecode.diagnostics.map((diagnostic) => diagnostic.message).join('\n'));
			assert.ok(sameLocalFile(warning.uri.fsPath, files.source), warning.uri.fsPath);
			assert.equal(warning.line, 6);

			// An error in the unsaved text names the source, and the -verbose lines are not in the output.
			// The messages are in English, also when a project argument sets another language.
			await assert.rejects(
				produceUnsaved('java', javacPath, 'assembly', files, text.replace('Helper.VALUE', 'missing'), {
					args: ['-J-Duser.language=de'],
					tools: { javap: { executable: javap, inputMode: 'file-argument' } },
				}),
				(error: unknown) =>
					error instanceof ToolExitError &&
					error.stderr.includes(`${files.source}:4: error: cannot find symbol`) &&
					!overlayFolder.test(error.stderr) &&
					!/^\[/mu.test(error.stderr),
			);
		},
	);
});

test('Roslyn compiles unsaved text with a #line directive', async (t) => {
	const dotnet = firstCommand(t, ['dotnet']);
	if (!dotnet) {
		return;
	}
	const tools = discoverDotNetTools(dotnet);
	if (!tools.compiler || !tools.ildasm) {
		t.skip('Roslyn or ildasm was not found');
		return;
	}
	const text =
		'public static class Buffer {\n    public static int BufferVersion(int n) {\n        int unused;\n        var total = 0;\n        for (var i = 0; i < n; i++) total += i * 7;\n        return total;\n    }\n}\n';
	await withUnsavedSource(
		'Main.cs',
		'public static class Saved { public static int SavedVersion() => 1; }\n',
		async (files) => {
			const il = await produceUnsaved('dotnet', dotnet, 'assembly', files, text, { tools });
			assertFromUnsavedText(il, /BufferVersion/u);
			const warning = il.diagnostics.find((diagnostic) => /CS0168/u.test(diagnostic.message));
			assert.ok(warning, il.diagnostics.map((diagnostic) => diagnostic.message).join('\n'));
			assert.ok(sameLocalFile(warning.uri.fsPath, files.source));
			assert.equal(warning.line, 2);
		},
	);
});
