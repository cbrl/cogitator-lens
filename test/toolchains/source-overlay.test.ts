import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
	cLineDirective,
	csharpSourceOverlay,
	goSourceOverlay,
	msvcSourceOverlay,
	overlayEncoding,
	pythonSourceOverlay,
	rustSourceOverlay,
	virtualFileSystem,
	withSourcePaths,
} from '../../src/toolchains/source-overlay.js';
import { ToolExitError } from '../../src/toolchains/toolchain-backend.js';
import { sameLocalFile } from '../../src/file-identity.js';
import { validateArtifactInputs } from '../../src/compilation/artifact-inputs.js';
import { defaultArtifactOptions } from '../../src/types/index.js';
import { neverCancelled, sourceUri, toolchainBackend } from '../support/toolchains.js';

test('a Clang VFS overlay maps the source to the overlay file and keeps the name of the source', () => {
	const overlay = JSON.parse(virtualFileSystem('/work/app/main.c', '/tmp/coglens-1/overlay/main.c', 'linux'));
	assert.equal(overlay['use-external-names'], false);
	assert.equal(overlay['case-sensitive'], 'true');
	assert.deepEqual(overlay.roots, [
		{
			name: '/work/app',
			type: 'directory',
			contents: [{ name: 'main.c', type: 'file', 'external-contents': '/tmp/coglens-1/overlay/main.c' }],
		},
	]);
	const windows = JSON.parse(virtualFileSystem('C:\\work\\app\\main.c', 'C:\\Temp\\overlay\\main.c', 'win32'));
	assert.equal(windows['case-sensitive'], 'false');
	assert.equal(windows.roots[0].name, 'C:\\work\\app');
});

test('a C #line directive escapes backslashes and quotation marks', () => {
	assert.equal(cLineDirective('C:\\work\\a "b"\\main.c'), '#line 1 "C:\\\\work\\\\a \\"b\\"\\\\main.c"\n');
	assert.equal(cLineDirective('/work/app/main.c'), '#line 1 "/work/app/main.c"\n');
});

test('compiler output names the source in place of the overlay file', () => {
	const posix = { sourcePath: '/work/app/main.c', overlayPath: '/tmp/coglens-1/overlay/main.c' };
	assert.equal(
		withSourcePaths('# 1 "/tmp/coglens-1/overlay/main.c"\nint x;', posix, '/work/app', 'linux'),
		'# 1 "/work/app/main.c"\nint x;',
	);

	const windows = { sourcePath: 'C:\\work\\app\\main.go', overlayPath: 'C:\\Temp\\coglens-1\\overlay\\main.go' };
	const output = [
		'#line 1 "C:\\\\Temp\\\\coglens-1\\\\overlay\\\\main.go"',
		'c:\\temp\\coglens-1\\overlay\\main.go(3): warning',
		'C:/Temp/coglens-1/overlay/main.go:3',
		'..\\..\\Temp\\coglens-1\\overlay\\main.go:3:19: declared and not used: unused',
	].join('\n');
	assert.equal(
		withSourcePaths(output, windows, 'C:\\work\\app', 'win32'),
		[
			'#line 1 "C:\\\\work\\\\app\\\\main.go"',
			'C:\\work\\app\\main.go(3): warning',
			'C:/work/app/main.go:3',
			'main.go:3:19: declared and not used: unused',
		].join('\n'),
	);
});

test('only a UTF-8 saved file gets an overlay file, which copies its byte order mark', () => {
	assert.deepEqual(overlayEncoding(Buffer.from('int x;\n')), { byteOrderMark: false });
	assert.deepEqual(overlayEncoding(Buffer.from('\uFEFFconst char *s = "é";\n')), { byteOrderMark: true });
	assert.equal(overlayEncoding(Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a])), undefined, 'Windows-1252');
	assert.equal(overlayEncoding(Buffer.from([0xff, 0xfe, 0x69, 0x00])), undefined, 'UTF-16');
});

test('a Rust crate that reads other files compiles the saved file', () => {
	const reason = (text: string) => rustSourceOverlay.unsupported?.(text, '/work/src/lib.rs');
	assert.match(reason('mod parser;\npub fn f() {}') ?? '', /mod, #\[path\], or include!/u);
	assert.ok(reason('#[cfg(test)]\npub(crate) mod tests;'));
	assert.ok(reason('#[path = "other.rs"]\nmod other { }'));
	assert.ok(reason('const DATA: &str = include_str!("data.txt");'));
	assert.equal(reason('mod tests {\n    #[test]\n    fn model() {}\n}'), undefined);
	assert.equal(reason('fn model() -> i32 { 1 }'), undefined);
});

test('each overlay names the input that its compiler reads', () => {
	const files = {
		sourcePath: path.join('/work', 'app', 'main.x'),
		overlayPath: path.join('/tmp', 'coglens-1', 'overlay', 'main.x'),
		temporaryDirectory: path.join('/tmp', 'coglens-1'),
	};
	const msvc = msvcSourceOverlay.invocation(files);
	assert.equal(msvc.inputPath, files.overlayPath);
	assert.deepEqual(msvc.leadingArguments, ['/I', path.dirname(files.sourcePath)]);
	assert.deepEqual(msvcSourceOverlay.rewriteArguments?.(['/c', '/FAcs', '/Faout.asm']), ['/c', '/FAc', '/Faout.asm']);
	assert.equal(msvcSourceOverlay.unsupported?.('', 'C:\\work\\main.c'), undefined);

	assert.equal(csharpSourceOverlay.header?.('C:\\work\\Main.cs'), '#line 1 "C:\\work\\Main.cs"\n');
	assert.ok(csharpSourceOverlay.unsupported?.('', '/work/a"b/Main.cs'), 'A C# #line name has no escapes');

	const go = goSourceOverlay.invocation(files);
	assert.equal(go.inputPath, files.sourcePath);
	const overlayFile = path.join(files.temporaryDirectory, 'overlay.json');
	assert.deepEqual(go.arguments, [`-overlay=${overlayFile}`]);
	assert.deepEqual(JSON.parse(go.files?.[overlayFile] ?? ''), { Replace: { [files.sourcePath]: files.overlayPath } });

	assert.deepEqual(pythonSourceOverlay.invocation(files), {
		inputPath: files.sourcePath,
		trailingArguments: [files.overlayPath],
	});
	assert.deepEqual(rustSourceOverlay.invocation(files).arguments, [
		`--remap-path-prefix=${path.dirname(files.overlayPath)}=${path.dirname(files.sourcePath)}`,
	]);
});

/** The folder of the overlay file in a path. */
const overlayFolder = /[\\/]overlay[\\/]/u;

/** A GCC stand-in that writes its input and a dependency file, and names the input in a warning. */
const fakeGcc = String.raw`
const fs = require('node:fs');
const args = process.argv.slice(2);
const input = args.at(-1);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(args) + '\n');
const text = fs.readFileSync(input, 'utf8');
const escape = (file) => file.replace(/([ \\])/g, '\\$1');
const dependencies = args.indexOf('-MF');
if (dependencies >= 0 && !process.env.FAKE_NO_DEPENDENCIES) {
	fs.writeFileSync(args[dependencies + 1], 'output.s: ' + escape(input) + ' ' + escape(process.env.FAKE_HEADER) + '\n');
}
fs.writeFileSync(args[args.indexOf('-o') + 1], input + '\n' + text);
process.stderr.write(input + ':1:1: warning: fake warning\n');
if (text.includes('FAIL')) {
	process.stderr.write(input + ':2:1: error: fake error\n');
	process.exitCode = 1;
}
`;

test('a compile of unsaved text reads the overlay file and names the source', async () => {
	const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'coglens-unsaved-'));
	try {
		const project = path.join(directory, 'real dir');
		await fs.promises.mkdir(project);
		const source = path.join(project, 'main.c');
		const header = path.join(project, 'local.h');
		await fs.promises.writeFile(source, 'int saved_version(void) { return 1; }\n');
		await fs.promises.writeFile(header, '#define LOCAL 7\n');
		const script = path.join(directory, 'fake-gcc.cjs');
		await fs.promises.writeFile(script, fakeGcc);
		const log = path.join(directory, 'runs.log');
		const backend = toolchainBackend('gcc', { executable: process.execPath, defaultArguments: [script] });
		const produce = (text: string, env: Readonly<Record<string, string>> = {}) =>
			backend.produceAssembly(
				sourceUri(source),
				{
					args: ['-DPROJECT'],
					env: { FAKE_LOG: log, FAKE_HEADER: header, ...env },
					workingDirectory: project,
					productionOptions: defaultArtifactOptions.production,
					sourceOverlay: { text, byteOrderMark: true },
				},
				neverCancelled,
			);

		const produced = await produce('#include "local.h"\nint buffer_version(void) { return LOCAL; }\n');
		const runs = (await fs.promises.readFile(log, 'utf8')).trim().split('\n');
		assert.equal(runs.length, 1, 'No second run lists the inputs');
		const args: string[] = JSON.parse(runs[0]);
		const input = args.at(-1) ?? '';
		assert.equal(path.basename(input), 'main.c');
		assert.equal(path.basename(path.dirname(input)), 'overlay');
		// The folder of the source comes after the default arguments of the toolchain and before the project.
		assert.deepEqual(args.slice(0, 4), [
			'-iquote',
			project,
			`-ffile-prefix-map=${path.dirname(input)}=${project}`,
			'-DPROJECT',
		]);

		const directive = cLineDirective(process.platform === 'win32' ? source.replaceAll('\\', '/') : source);
		assert.ok(produced.text.startsWith(`${source}\n\uFEFF${directive}#include "local.h"`), produced.text);
		assert.match(produced.text, /buffer_version/u);
		assert.doesNotMatch(produced.text, overlayFolder);
		assert.ok(produced.diagnostics.length > 0);
		assert.ok(produced.diagnostics.every((diagnostic) => sameLocalFile(diagnostic.uri.fsPath, source)));
		assert.equal(produced.dependencyCoverage, 'complete');
		assert.deepEqual(
			produced.inputs.map((input) => sameLocalFile(fileURLToPath(input.uri), header)),
			[true],
			'The header is an input, and the source and the overlay file are not',
		);

		// Without a list of its headers, the output of unsaved text never validates, so no request uses it again.
		const unlisted = await produce('int unlisted(void) { return 2; }\n', { FAKE_NO_DEPENDENCIES: '1' });
		assert.equal(await validateArtifactInputs(unlisted.inputs, true), false);
		assert.equal((await fs.promises.readFile(log, 'utf8')).trim().split('\n').length, 2, 'No second run');

		await assert.rejects(produce('FAIL\n'), (error: unknown) => {
			assert.ok(error instanceof ToolExitError);
			assert.match(error.stderr, /fake error/u);
			assert.ok(error.stderr.includes(`${source}:2:1`), error.stderr);
			assert.doesNotMatch(error.stderr, overlayFolder);
			return true;
		});
	} finally {
		await fs.promises.rm(directory, { recursive: true, force: true });
	}
});
