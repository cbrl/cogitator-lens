import assert from 'node:assert/strict';
import test from 'node:test';
import { supportedArtifactKinds } from '../../src/artifacts/core/artifact-definitions.js';
import {
	getArtifactOutputChoices,
	resolveArtifactAvailability,
	resolveArtifactOptionAvailability,
	resolveArtifactOutput,
	supportedToolchainKinds,
	toolchainDefinitions,
	type ToolchainDefinition,
} from '../../src/toolchains/toolchain-map.js';
import type { ArtifactKind, ToolchainKind } from '../../src/types/index.js';
import { artifactAvailability, toolchainProfile } from '../support/toolchains.js';

/**
 * The artifact matrix, stated once.
 *
 * `unavailable` means the producer exists but needs a tool the profile does not
 * name; the profiles here configure none, so those cells are deterministic.
 * Every toolchain omitted from a row is `unsupported`.
 */
const matrix: Readonly<
	Record<
		ArtifactKind,
		{ readonly available?: readonly ToolchainKind[]; readonly unavailable?: readonly ToolchainKind[] }
	>
> = {
	assembly: {
		available: ['gcc', 'clang', 'apple-clang', 'clang-cl', 'msvc', 'rust', 'python', 'go', 'zig', 'nvcc'],
		unavailable: ['dotnet'],
	},
	'binary-disassembly': { unavailable: ['gcc', 'clang', 'apple-clang', 'clang-cl', 'msvc', 'nvcc'] },
	'preprocessed-source': { available: ['gcc', 'clang', 'apple-clang', 'clang-cl', 'msvc', 'nvcc'] },
	ast: { available: ['clang', 'apple-clang', 'clang-cl', 'python'] },
	'llvm-ir': { available: ['clang', 'apple-clang', 'clang-cl', 'rust', 'zig'] },
	'rust-mir': { available: ['rust'] },
	'optimization-remarks': { available: ['gcc', 'clang', 'apple-clang', 'clang-cl'] },
	'stack-analysis': { available: ['gcc', 'clang', 'apple-clang', 'clang-cl', 'python'] },
	'control-flow-graph': {
		available: ['gcc', 'clang', 'apple-clang', 'clang-cl', 'msvc', 'rust', 'python', 'go', 'zig'],
	},
};

/** The compiler outputs each toolchain offers for a control-flow graph, in menu order. */
const controlFlowOutputs: Readonly<Partial<Record<ToolchainKind, readonly string[]>>> = {
	// MSVC has no IR dump, but its `/FAcs` listing is enough for a machine-level graph.
	gcc: ['gcc-tree', 'assembly'],
	clang: ['llvm-ir', 'assembly'],
	'apple-clang': ['llvm-ir', 'assembly'],
	'clang-cl': ['llvm-ir', 'assembly'],
	zig: ['llvm-ir', 'assembly'],
	msvc: ['assembly'],
	rust: ['rust-mir', 'llvm-ir', 'assembly'],
	python: ['python-bytecode'],
	dotnet: [],
	go: ['go-ssa'],
	nvcc: [],
};

test('every toolchain declares a cell for every artifact kind and implements at least one', () => {
	assert.ok(supportedArtifactKinds.length > 0);
	assert.deepEqual([...supportedArtifactKinds].sort(), Object.keys(matrix).sort());
	for (const kind of supportedToolchainKinds) {
		const definition = toolchainDefinitions[kind];
		assert.deepEqual(Object.keys(definition.artifacts), supportedArtifactKinds);
		assert.ok(definition.languageIdentifiers.length > 0, `${kind} claims no language`);
		assert.ok(
			Object.values(definition.artifacts).some((cell) => cell.status === 'available'),
			`${kind} implements no artifact`,
		);
	}
});

test('artifact availability matches the declared matrix for every toolchain', () => {
	for (const artifact of supportedArtifactKinds) {
		const row = matrix[artifact];
		assert.deepEqual(
			Object.fromEntries(supportedToolchainKinds.map((kind) => [kind, artifactAvailability(kind, artifact)])),
			Object.fromEntries(
				supportedToolchainKinds.map((kind) => [
					kind,
					row.available?.includes(kind)
						? 'available'
						: row.unavailable?.includes(kind)
							? 'unavailable'
							: 'unsupported',
				]),
			),
			`unexpected availability row for ${artifact}`,
		);
	}
});

test('an artifact that needs an external tool becomes available once the profile names it', () => {
	assert.equal(
		resolveArtifactAvailability(
			toolchainProfile('gcc', { tools: { disassembler: process.execPath } }),
			'binary-disassembly',
		).status,
		'available',
	);
	assert.equal(
		resolveArtifactAvailability(
			toolchainProfile('dotnet', { tools: { compiler: 'csc.dll', ildasm: 'ildasm' } }),
			'assembly',
		).status,
		'available',
	);
});

test('control-flow graph outputs are ordered per toolchain and own compatible parsers', () => {
	for (const kind of supportedToolchainKinds) {
		assert.deepEqual(
			getArtifactOutputChoices(toolchainProfile(kind), 'control-flow-graph').map((output) => output.id),
			controlFlowOutputs[kind],
			`unexpected control-flow outputs for ${kind}`,
		);
	}
	// A graph artifact must be asked for by output; an unknown output is refused.
	assert.equal(resolveArtifactOutput(toolchainProfile('rust'), 'control-flow-graph').status, 'unsupported');
	assert.equal(
		resolveArtifactOutput(toolchainProfile('rust'), 'control-flow-graph', 'unknown').status,
		'unsupported',
	);

	for (const kind of supportedToolchainKinds) {
		const definition: ToolchainDefinition = toolchainDefinitions[kind];
		const cell = definition.artifacts['control-flow-graph'];
		if (cell.status !== 'available') {
			continue;
		}
		assert.ok(cell.outputs, `${kind} exposes no control-flow outputs`);
		for (const output of cell.outputs) {
			assert.equal(typeof output.parseGraphs, 'function', `${kind}/${output.id} owns no parser`);
			if (output.id === 'assembly') {
				assert.equal(typeof definition.createCfgParser, 'function', `${kind} owns no assembly CFG parser`);
			}
		}
	}
});

test('production options are available, inherent, or unsupported per toolchain', () => {
	// GCC can emit Intel syntax, but demangling needs a tool that is not configured.
	assert.equal(
		resolveArtifactOptionAvailability(toolchainProfile('gcc'), 'assembly', 'demangle').status,
		'unavailable',
	);
	const withDemangler = toolchainProfile('clang', { tools: { demangler: process.execPath } });
	assert.equal(resolveArtifactOptionAvailability(withDemangler, 'assembly', 'demangle').status, 'available');
	assert.equal(resolveArtifactOptionAvailability(withDemangler, 'assembly', 'intel').status, 'available');

	// MSVC always emits Intel syntax, so the option exists but cannot be toggled.
	const msvcIntel = resolveArtifactOptionAvailability(toolchainProfile('msvc'), 'assembly', 'intel');
	assert.equal(msvcIntel.status, 'unavailable');
	assert.equal(msvcIntel.reason, 'inherent');

	// Python emits no machine code, so assembly syntax is not a concept there.
	assert.equal(
		resolveArtifactOptionAvailability(toolchainProfile('python'), 'assembly', 'intel').status,
		'unsupported',
	);
	const pythonDemangle = resolveArtifactOptionAvailability(toolchainProfile('python'), 'assembly', 'demangle');
	assert.equal(pythonDemangle.status, 'unsupported');
	assert.match(pythonDemangle.explanation, /python bytecode rather than native assembly/i);
	const dotNetIntel = resolveArtifactOptionAvailability(toolchainProfile('dotnet'), 'assembly', 'intel');
	assert.equal(dotNetIntel.status, 'unsupported');
	assert.match(dotNetIntel.explanation, /dotnet il rather than native assembly/i);
});
