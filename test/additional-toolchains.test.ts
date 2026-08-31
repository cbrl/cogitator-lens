import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { parseGoSsaControlFlowGraphs } from '../src/artifacts/control-flow-graph/parsers/go-ssa-cfg-parser.js';
import { artifactDefinitions } from '../src/artifacts/core/artifact-definitions.js';
import {
	detectToolchainDefinition,
	resolveArtifactAvailability,
	toolchainDefinitions,
} from '../src/toolchains/toolchain-map.js';
import { ToolchainBackend } from '../src/toolchains/toolchain-backend.js';
import { inferGoSsaFunction } from '../src/toolchains/go.js';
import { zigLlvmIrOutput, zigOutputArguments } from '../src/toolchains/zig.js';
import { nvccOutputArguments, nvdisasm } from '../src/toolchains/nvcc.js';
import type {
	ArtifactKind,
	ArtifactRenderContext,
	RawArtifact,
	ToolchainKind,
	ToolchainProfile,
} from '../src/types/index.js';
import { defaultArtifactOptions } from '../src/types/index.js';
import { testToolchainHost } from './toolchain-host.js';

test('additional toolchains expose their native compiler outputs', () => {
	assert.equal(availability('go', 'assembly'), 'available');
	assert.equal(availability('go', 'control-flow-graph'), 'available');
	assert.equal(availability('zig', 'llvm-ir'), 'available');
	assert.equal(availability('nvcc', 'assembly'), 'available');
	assert.equal(availability('nvcc', 'binary-disassembly'), 'unavailable');
	assert.equal(detectToolchainDefinition('go.exe')?.kind, 'go');
	assert.equal(detectToolchainDefinition('zig')?.kind, 'zig');
	assert.equal(detectToolchainDefinition('nvcc.exe')?.kind, 'nvcc');
	assert.ok(toolchainDefinitions.nvcc.languageIdentifiers.includes('cuda-cpp'));

	assert.deepEqual(zigOutputArguments('assembly', 'out.s'), [
		'build-obj', '-fllvm', '-fno-strip', '-fno-emit-bin', '-femit-asm=out.s',
	]);
	assert.deepEqual(zigLlvmIrOutput.arguments('out.ll'), [
		'build-obj', '-fllvm', '-fno-strip', '-fno-emit-bin', '-femit-llvm-ir=out.ll',
	]);
	assert.deepEqual(nvccOutputArguments('assembly', 'out.ptx'), [
		'--ptx', '--generate-line-info', '--keep-device-functions', '-o', 'out.ptx',
	]);
	assert.deepEqual(nvccOutputArguments('object', 'out.cubin'), [
		'--cubin', '--generate-line-info', '--keep-device-functions', '-o', 'out.cubin',
	]);
	assert.deepEqual(nvdisasm.arguments('out.cubin'), ['out.cubin', '-c', '-g', '-hex']);
});

test('Go SSA parser retains final blocks, typed branches, and source mappings', () => {
	const parsed = parseGoSsaControlFlowGraphs([
		'generating SSA for classify',
		'classify func(int) int',
		'  b1:',
		'    (+4) v1 = ArgIntReg <int> {value+0}',
		'    If v1 -> b2 b3 (likely)',
		'  b2:',
		'    (+5) Ret v1',
		'  b3:',
		'    (+7) Ret v2',
		'  pass trim begin',
		'  pass trim end [0 ns]',
		'classify func(int) int',
		'  b1:',
		'    (+4) v1 = TESTQ <flags>',
		'    If v1 -> b2 b3',
		'  b2:',
		'    (+5) Ret v1',
		'  b3:',
		'    (+7) Ret v2',
		'genssa classify',
	].join('\n'), 'file:///project/source.go');
	assert.equal(parsed.graphs.length, 1);
	assert.deepEqual(parsed.graphs[0].edges.map(edge => edge.kind), ['true', 'false']);
	assert.equal(parsed.graphs[0].nodes[0].source?.line, 3);
	assert.match(parsed.graphs[0].nodes[0].label, /TESTQ/u);
	assert.doesNotMatch(parsed.graphs[0].nodes[0].label, /ArgIntReg/u);
});

test('installed Go compiler produces normalized assembly and its GOSSAFUNC CFG', async t => {
	if (spawnSync('go', ['version'], { encoding: 'utf8' }).status !== 0) {
		t.skip('Go is not installed');
		return;
	}
	const source = path.resolve('test/fixtures/go/source.go');
	assert.equal(await inferGoSsaFunction(source), 'command-line-arguments.classify');
	const backend = new ToolchainBackend(profile('go', 'go'), toolchainDefinitions.go, testToolchainHost);
	const options = {
		workingDirectory: path.dirname(source),
		productionOptions: defaultArtifactOptions.production,
	};
	const assemblyCell = toolchainDefinitions.go.artifacts.assembly;
	assert.equal(assemblyCell.status, 'available');
	assert.equal(assemblyCell.outputs, undefined);
	const assembly = await assemblyCell.producer(backend, fileUri(source), options, neverCancelled);
	const parsedAssembly = backend.parseAssembly(assembly.text, defaultArtifactOptions.display);
	assert.ok(parsedAssembly.asm.some(line => /(?:TEXT|CMPQ|JLE|NEGQ|RET)/u.test(line.text)));

	const graphCell = toolchainDefinitions.go.artifacts['control-flow-graph'];
	assert.equal(graphCell.status, 'available');
	const output = graphCell.outputs?.[0];
	assert.ok(output);
	const rawGraph = await output.producer(backend, fileUri(source), options, neverCancelled);
	assert.equal(fs.existsSync(path.join(path.dirname(source), 'ssa.html')), false);
	const graphs = output.parseGraphs?.(
		rawGraph,
		defaultArtifactOptions.display,
		{ backend, source: { uri: fileUri(source), text: fs.readFileSync(source, 'utf8') } },
	);
	assert.ok(graphs?.graphs.some(graph => graph.label === 'classify'));
});

test('installed nvcc produces line-mapped PTX through the vendored CE parser', async t => {
	if (spawnSync('nvcc', ['--version'], { encoding: 'utf8' }).status !== 0) {
		t.skip('nvcc is not installed');
		return;
	}
	const source = path.resolve('test/fixtures/cuda/kernel.cu');
	const backend = new ToolchainBackend(profile('nvcc', 'nvcc'), toolchainDefinitions.nvcc, testToolchainHost);
	const cell = toolchainDefinitions.nvcc.artifacts.assembly;
	assert.equal(cell.status, 'available');
	assert.equal(cell.outputs, undefined);
	const raw = await cell.producer(backend, fileUri(source), {
		workingDirectory: path.dirname(source),
		productionOptions: defaultArtifactOptions.production,
	}, neverCancelled);
	assert.match(raw.text, /\.visible\s+\.entry\s+saxpy/u);
	const parsed = backend.parseAssembly(raw.text, defaultArtifactOptions.display);
	assert.ok(parsed.asm.some(line => /fma\.rn\.f32|mul\.wide|st\.global/u.test(line.text)));
	assert.ok(parsed.asm.some(line => line.source?.file?.endsWith('kernel.cu')));

	const sassBackend = new ToolchainBackend({
		...profile('nvcc', 'nvcc'),
		tools: { disassembler: 'nvdisasm' },
	}, toolchainDefinitions.nvcc, testToolchainHost);
	const binaryCell = toolchainDefinitions.nvcc.artifacts['binary-disassembly'];
	assert.equal(binaryCell.status, 'available');
	assert.equal(binaryCell.outputs, undefined);
	const sass = await binaryCell.producer(sassBackend, fileUri(source), {
		workingDirectory: path.dirname(source),
		productionOptions: defaultArtifactOptions.production,
	}, neverCancelled);
	const parsedSass = sassBackend.parseBinaryDisassembly(sass.text, defaultArtifactOptions.display);
	assert.ok(parsedSass.asm.some(line => /(?:FMA|STG|EXIT)/u.test(line.disassembly ?? line.text)));
	assert.ok(parsedSass.asm.some(line => line.address !== undefined && line.opcodes?.length));
});

function availability(toolchain: ToolchainKind, artifact: ArtifactKind): string {
	return resolveArtifactAvailability(profile(toolchain), artifact).status;
}

function profile(kind: ToolchainKind, executable = process.execPath): ToolchainProfile {
	return {
		id: `test:${kind}`,
		displayName: `Test ${kind}`,
		kind,
		executable,
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
			workingDirectory: path.resolve('project'),
		},
		truncated: false,
		inputs: [],
		dependencyCoverage: 'source-only',
	};
}

const neverCancelled = {
	isCancellationRequested: false,
	onCancellationRequested: () => ({ dispose: () => undefined }),
} as never;

function fileUri(filename: string) {
	return {
		fsPath: filename,
		path: filename.replaceAll('\\', '/'),
		toString: () => pathToFileURL(filename).href,
	} as never;
}
