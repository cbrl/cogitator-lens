import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
	artifactDefinitions,
} from '../src/artifacts/core/artifact-definitions.js';
import {
	dumpbin,
	gnuObjdump,
	llvmObjdump,
	normalizeDisassemblySourcePaths,
	normalizeDumpbinOutput,
} from '../src/artifacts/compiler/binary-disassembly-producer.js';
import { ToolchainBackend } from '../src/toolchains/toolchain-backend.js';
import {
	createToolchainProfile,
	getToolchainDefinition,
	resolveArtifactAvailability,
	toolchainDefinitions,
} from '../src/toolchains/toolchain-map.js';
import type {
	ArtifactRenderContext,
	RawArtifact,
	ToolchainProfile,
} from '../src/types/index.js';
import { defaultArtifactOptions } from '../src/types/index.js';

test('binary command construction is toolchain-owned and shell-free', () => {
	assert.deepEqual(getToolchainDefinition('gcc').outputArguments?.('object', 'artifact.o', []), [
		'-c',
		'-g1',
		'-o',
		'artifact.o',
	]);
	assert.deepEqual(getToolchainDefinition('clang').outputArguments?.('object', 'artifact.o', []), [
		'-c',
		'-gline-tables-only',
		'-o',
		'artifact.o',
	]);
	assert.deepEqual(getToolchainDefinition('msvc').outputArguments?.('object', 'artifact.obj', []), [
		'/nologo',
		'/c',
		'/Z7',
		'/Foartifact.obj',
	]);
	assert.deepEqual(getToolchainDefinition('clang-cl').outputArguments?.('object', 'artifact.obj', []), [
		'/nologo',
		'/c',
		'/Z7',
		'/Foartifact.obj',
	]);
	assert.deepEqual(gnuObjdump.arguments('artifact with spaces.o'), [
		'-d',
		'-l',
		'-w',
		'artifact with spaces.o',
	]);
	assert.deepEqual(llvmObjdump.arguments('artifact with spaces.o'), [
		'--disassemble',
		'--line-numbers',
		'artifact with spaces.o',
	]);
	assert.deepEqual(dumpbin.arguments('artifact with spaces.obj'), [
		'/nologo',
		'/disasm:bytes',
		'/linenumbers',
		'artifact with spaces.obj',
	]);
});

test('binary availability requires the disassembler declared by the artifact cell', () => {
	const missing = profile('gcc');
	assert.equal(resolveArtifactAvailability(missing, 'binary-disassembly').status, 'unavailable');
	const configured = {
		...missing,
		tools: { disassembler: process.execPath },
	};
	assert.equal(
		resolveArtifactAvailability(configured, 'binary-disassembly').status,
		'available',
	);
	assert.equal(
		resolveArtifactAvailability(profile('rust'), 'binary-disassembly').status,
		'unsupported',
	);
});

test('profile creation discovers and merges named auxiliary tools', () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coglens-tools-'));
	try {
		const executable = path.join(directory, process.platform === 'win32' ? 'gcc.exe' : 'gcc');
		const demangler = path.join(
			directory,
			process.platform === 'win32' ? 'c++filt.exe' : 'c++filt',
		);
		const disassembler = path.join(
			directory,
			process.platform === 'win32' ? 'objdump.exe' : 'objdump',
		);
		for (const file of [executable, demangler, disassembler]) {
			fs.writeFileSync(file, '');
		}
		const analyzer = process.execPath;
		const detected = createToolchainProfile('gcc', 'Detected GCC', executable, {
			tools: { analyzer },
		});
		assert.deepEqual(detected.tools, {
			demangler,
			disassembler,
			analyzer,
		});
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test('GNU disassembly renders addresses, bytes, links, source mappings, symbols, and size', () => {
	const backend = new ToolchainBackend(profile('gcc'), toolchainDefinitions.gcc);
	const raw = rawArtifact(platformFixture('test/fixtures/binary/gnu-objdump.txt'));
	const rendered = artifactDefinitions['binary-disassembly'].renderer(
		raw,
		defaultArtifactOptions.display,
		renderContext(backend),
	);

	assert.ok(rendered.lines.some(line =>
		line.address === 1
		&& line.opcodes?.length === 5
		&& line.disassembly?.includes('call')));
	assert.ok(rendered.sourceLocations.some(location => location.sourceLine === 7));
	assert.ok(rendered.links.some(link => link.targetLine >= 0));
	assert.ok(rendered.symbols.some(symbol => symbol.name === 'helper'));
	assert.ok(rendered.folds.some(fold => fold.endLine > fold.startLine));
	assert.equal(rendered.metrics.codeSizeBytes, 11);
	assert.equal(rendered.metrics.instructionCount, 5);
});

test('dumpbin output is adapted before using the common raw-assembly parser', () => {
	const normalized = normalizeDumpbinOutput(
		platformFixture('test/fixtures/binary/dumpbin.txt'),
	);
	assert.match(normalized, /0 <\?helper@@YAHH@Z>:/);
	assert.match(normalized, /0: 55\s+push/);
	assert.match(normalized, /9 <\?entry@@YAHH@Z>:/);
	assert.match(normalized, /call\s+0+ <\?helper@@YAHH@Z>/);

	const backend = new ToolchainBackend(profile('msvc'), toolchainDefinitions.msvc);
	const rendered = artifactDefinitions['binary-disassembly'].renderer(
		rawArtifact(normalized),
		defaultArtifactOptions.display,
		renderContext(backend),
	);
	assert.ok(rendered.lines.some(line => line.address === 9 && line.opcodes?.length === 3));
	assert.ok(rendered.sourceLocations.some(location => location.sourceLine === 3));
	assert.ok(rendered.links.some(link => link.targetLine >= 0));
	assert.equal(
		normalizeDisassemblySourcePaths('c:\\project path\\source.cpp:12'),
		'C:/project path/source.cpp:12',
	);
});

test('malformed disassembler output produces a valid empty normalized artifact', () => {
	const backend = new ToolchainBackend(profile('gcc'), toolchainDefinitions.gcc);
	const rendered = artifactDefinitions['binary-disassembly'].renderer(
		rawArtifact('not disassembly'),
		defaultArtifactOptions.display,
		renderContext(backend),
	);
	assert.deepEqual(rendered.lines, []);
	assert.equal(rendered.metrics.codeSizeBytes, 0);
	assert.equal(rendered.metrics.instructionCount, 0);
});

function profile(kind: ToolchainProfile['kind']): ToolchainProfile {
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

function renderContext(backend: ToolchainBackend): ArtifactRenderContext {
	return {
		backend,
		source: {
			uri: { fsPath: '/project/source.cpp' } as never,
			text: '',
		},
	};
}

function rawArtifact(text: string): RawArtifact {
	return {
		kind: 'binary-disassembly',
		text,
		diagnostics: [],
		durationMs: 1,
		generatedAt: 0,
		command: {
			executable: process.execPath,
			arguments: [],
			environmentVariableNames: [],
			workingDirectory: process.cwd(),
		},
		truncated: false,
		inputs: [],
		dependencyCoverage: 'source-only',
	};
}

function platformFixture(filename: string): string {
	const text = fs.readFileSync(filename, 'utf8');
	return process.platform === 'win32'
		? text
		: text.replaceAll('C:/project', '/project');
}
