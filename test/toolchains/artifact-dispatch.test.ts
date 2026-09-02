import assert from 'node:assert/strict';
import test from 'node:test';
import { renderControlFlowGraphArtifact } from '../../src/artifacts/control-flow-graph/control-flow-graph-renderer.js';
import { clangClLlvmIrOutput, llvmIrOutput } from '../../src/artifacts/core/compiler-output-producer.js';
import { rustLlvmIrOutput, rustMirOutput } from '../../src/toolchains/rust.js';
import { clangClOptimizationRemarksOutput } from '../../src/artifacts/optimization-remarks/clang-cl-optimization-remarks.js';
import { pythonCfgHelper, pythonControlFlowGraphProducer } from '../../src/artifacts/python/python-cfg-producer.js';
import { pythonAstHelper } from '../../src/artifacts/ast/python-ast-producer.js';
import { pythonStackAnalysisHelper } from '../../src/artifacts/stack-analysis/python-stack-analysis.js';
import { defaultArtifactOptions } from '../../src/types/index.js';
import { rawArtifact, renderContext } from '../support/artifacts.js';
import { availableCell, availableOutput, recordProduction, toolchainBackend } from '../support/toolchains.js';

test('an artifact cell routes to the output specification its toolchain owns', async () => {
	for (const [toolchain, artifact, expected] of [
		['clang', 'llvm-ir', llvmIrOutput],
		['clang-cl', 'llvm-ir', clangClLlvmIrOutput],
		['clang-cl', 'optimization-remarks', clangClOptimizationRemarksOutput],
	] as const) {
		const recorded = await recordProduction(availableCell(toolchain, artifact).producer);
		assert.equal(recorded.kind, artifact);
		assert.equal(recorded.spec, expected, `${toolchain}/${artifact} used the wrong specification`);
	}
});

test('a control-flow output routes to the compiler output it names', async () => {
	for (const [toolchain, outputId, artifactKind, outputFilename, expectedArguments] of [
		[
			'clang',
			'llvm-ir',
			'control-flow-graph',
			'output.ll',
			['-emit-llvm', '-S', '-gline-tables-only', '-o', 'cfg.ll'],
		],
		[
			'apple-clang',
			'llvm-ir',
			'control-flow-graph',
			'output.ll',
			['-emit-llvm', '-S', '-gline-tables-only', '-o', 'cfg.ll'],
		],
		[
			'clang-cl',
			'llvm-ir',
			'control-flow-graph',
			'output.ll',
			['/clang:-emit-llvm', '/clang:-S', '/clang:-gline-tables-only', '/clang:-o', '/clang:cfg.ll'],
		],
		[
			'rust',
			'rust-mir',
			'control-flow-graph',
			'output.mir',
			[
				'--crate-name=coglens_artifact',
				'--crate-type=lib',
				'--emit=mir=cfg.mir',
				'--error-format=human',
				'--color=never',
			],
		],
	] as const) {
		const output = availableOutput(toolchain, artifactKind, outputId);
		const recorded = await recordProduction(output.producer, {
			outputFile: outputId === 'rust-mir' ? 'cfg.mir' : 'cfg.ll',
		});
		assert.equal(recorded.kind, artifactKind);
		assert.equal(recorded.outputFilename, outputFilename);
		assert.deepEqual(recorded.arguments, expectedArguments, `${toolchain}/${outputId}`);
	}

	// Rust reuses the same two specifications outside the graph path.
	for (const [outputId, expected] of [
		['rust-mir', rustMirOutput],
		['llvm-ir', rustLlvmIrOutput],
	] as const) {
		const recorded = await recordProduction(availableOutput('rust', 'control-flow-graph', outputId).producer);
		assert.equal(recorded.spec, expected);
	}

	// The assembly output has no specification of its own; it reuses the shared path.
	const assembly = await recordProduction(availableOutput('rust', 'control-flow-graph', 'assembly').producer);
	assert.equal(assembly.viaAssembly, true);
	assert.equal(assembly.kind, 'control-flow-graph');
});

test('stdout-backed producers pass execution modes rather than an output file', async () => {
	for (const [toolchain, artifact, expected] of [
		['gcc', 'preprocessed-source', ['-E']],
		['msvc', 'preprocessed-source', ['/E']],
		['python', 'assembly', ['-m', 'dis']],
	] as const) {
		const recorded = await recordProduction(availableCell(toolchain, artifact).producer, {
			profileKind: toolchain,
		});
		assert.equal(recorded.kind, artifact);
		assert.equal(recorded.output, 'stdout');
		assert.deepEqual(recorded.arguments, expected, `${toolchain}/${artifact}`);
	}

	const cfg = await recordProduction(pythonControlFlowGraphProducer);
	assert.equal(cfg.kind, 'control-flow-graph');
	assert.equal(cfg.output, 'stdout');
	assert.deepEqual(cfg.arguments, ['-I', '-c', pythonCfgHelper]);
});

test('the Python helpers compile the source instead of importing or executing it', () => {
	assert.match(pythonCfgHelper, /compile\(source,filename,"exec"/u);
	assert.match(pythonAstHelper, /tokenize\.open/u);
	assert.match(pythonAstHelper, /ast\.parse/u);
	assert.match(pythonStackAnalysisHelper, /compile\(source,filename,'exec'\)/u);
	for (const helper of [pythonCfgHelper, pythonAstHelper, pythonStackAnalysisHelper]) {
		assert.doesNotMatch(helper, /\bimport_module\b|\bexecfile\b|\bexec\s*\(/u);
	}
});

test('a selected control-flow output is rendered by the parser that output declares', () => {
	const source = { file: '/project/source.rs' };
	const llvm = renderControlFlowGraphArtifact(
		rawArtifact('control-flow-graph', ['define void @selected() {', 'entry:', '  ret void', '}'].join('\n')),
		defaultArtifactOptions.display,
		renderContext('rust', source, availableOutput('rust', 'control-flow-graph', 'llvm-ir')),
	);
	assert.deepEqual(
		llvm.graphs.map((graph) => graph.id),
		['llvm:selected'],
	);

	// The assembly output renders whatever the toolchain's assembly parser returns.
	const rustBackend = toolchainBackend('rust');
	const backend = {
		profile: rustBackend.profile,
		parseAssembly: () => ({
			asm: [
				{ text: 'selected:' },
				{ text: '\tje\t.LBB0_1', source: { file: null, line: 1, column: 1 } },
				{ text: '\tret', source: { file: null, line: 2, column: 1 } },
				{ text: '.LBB0_1:' },
				{ text: '\tret', source: { file: null, line: 3, column: 1 } },
			],
			labelDefinitions: {},
		}),
		parseAssemblyControlFlowGraph: rustBackend.parseAssemblyControlFlowGraph.bind(rustBackend),
	} as never;
	const assembly = renderControlFlowGraphArtifact(
		rawArtifact('control-flow-graph', ''),
		defaultArtifactOptions.display,
		renderContext(backend, source, availableOutput('rust', 'control-flow-graph', 'assembly')),
	);
	assert.deepEqual(
		assembly.graphs.map((graph) => graph.id),
		['clang-asm:selected'],
	);
	assert.deepEqual(
		assembly.graphs[0].edges.map((edge) => edge.kind),
		['true', 'false'],
	);
});
