import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
	dumpbin,
	gnuObjdump,
	llvmObjdump,
} from '../../src/artifacts/binary-disassembly/binary-disassembly-producer.js';
import {
	clangClLlvmIrOutput,
	gccControlFlowGraphOutput,
	llvmIrOutput,
	rustArtifactArguments,
} from '../../src/artifacts/core/compiler-output-producer.js';
import { clangClOptimizationRemarksOutput } from '../../src/artifacts/optimization-remarks/clang-cl-optimization-remarks.js';
import { clangOptimizationRemarksOutput } from '../../src/artifacts/optimization-remarks/clang-optimization-remarks.js';
import { gccOptimizationRemarksOutput } from '../../src/artifacts/optimization-remarks/gcc-optimization-remarks.js';
import {
	clangClStackUsageOutput,
	nativeStackUsageOutput,
} from '../../src/artifacts/stack-analysis/native-stack-analysis.js';
import { flattenCmakeArguments } from '../../src/buildsystems/cmake-arguments.js';
import { rustOutputArguments } from '../../src/toolchains/rust.js';
import { nvccOutputArguments, nvdisasm } from '../../src/toolchains/nvcc.js';
import { zigLlvmIrOutput, zigOutputArguments } from '../../src/toolchains/zig.js';
import { intelOutputArguments } from '../../src/toolchains/toolchain-backend.js';
import {
	getToolchainDefinition,
	supportedToolchainKinds,
	toolchainDefinitions,
} from '../../src/toolchains/toolchain-map.js';

const temporary = '/temporary';
const windowsTemporary = 'C:\\temporary';

test('object-file arguments carry line tables and name their own output', () => {
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
	for (const kind of ['msvc', 'clang-cl'] as const) {
		assert.deepEqual(getToolchainDefinition(kind).outputArguments?.('object', 'artifact.obj', []), [
			'/nologo',
			'/c',
			'/Z7',
			'/Foartifact.obj',
		]);
	}
});

test('disassembler arguments stay shell-free with a path that contains spaces', () => {
	assert.deepEqual(gnuObjdump.arguments('artifact with spaces.o'), ['-d', '-l', '-w', 'artifact with spaces.o']);
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
	assert.deepEqual(nvdisasm.arguments('out.cubin'), ['out.cubin', '-c', '-g', '-hex']);
});

test('LLVM IR specifications request line tables and own their output file', () => {
	assert.deepEqual(llvmIrOutput.arguments('artifact.ll', temporary, []), [
		'-emit-llvm',
		'-S',
		'-gline-tables-only',
		'-o',
		'artifact.ll',
	]);
	assert.deepEqual(clangClLlvmIrOutput.arguments('C:\\temporary\\artifact.ll', temporary, []), [
		'/clang:-emit-llvm',
		'/clang:-S',
		'/clang:-gline-tables-only',
		'/clang:-o',
		'/clang:C:\\temporary\\artifact.ll',
	]);
	assert.deepEqual(zigLlvmIrOutput.arguments('out.ll'), [
		'build-obj',
		'-fllvm',
		'-fno-strip',
		'-fno-emit-bin',
		'-femit-llvm-ir=out.ll',
	]);
});

test('optimization-record specifications compile to a throwaway object beside the record', () => {
	assert.deepEqual(clangOptimizationRemarksOutput.arguments('artifact.opt.yaml', temporary, []), [
		'-c',
		'-fsave-optimization-record=yaml',
		'-foptimization-record-file=artifact.opt.yaml',
		'-o',
		path.join(temporary, 'output.o'),
	]);
	assert.deepEqual(
		clangClOptimizationRemarksOutput.arguments('C:\\temporary\\artifact.opt.yaml', windowsTemporary, []),
		[
			'/c',
			'/clang:-fsave-optimization-record=yaml',
			'/clang:-foptimization-record-file=C:\\temporary\\artifact.opt.yaml',
			`/Fo${path.join(windowsTemporary, 'output.obj')}`,
		],
	);
	assert.deepEqual(gccOptimizationRemarksOutput.arguments('artifact.opt', temporary, []), [
		'-c',
		'-fopt-info-all=artifact.opt',
		'-o',
		path.join(temporary, 'output.o'),
	]);
});

test('stack-usage and GCC control-flow specifications own their object and dump names', () => {
	assert.deepEqual(nativeStackUsageOutput.arguments('output.su', temporary, []), [
		'-c',
		'-fstack-usage',
		'-fno-lto',
		'-o',
		path.join(temporary, 'output.o'),
	]);
	assert.deepEqual(clangClStackUsageOutput.arguments('C:\\temporary\\output.su', windowsTemporary, []), [
		'/c',
		'/clang:-fstack-usage',
		'/clang:-fno-lto',
		'/clang:-gline-tables-only',
		'/clang:-o',
		`/clang:${path.join(windowsTemporary, 'output.obj')}`,
	]);

	const outputFile = path.join(temporary, 'coglens', 'output.cfg');
	assert.deepEqual(gccControlFlowGraphOutput.output, { filename: 'output.cfg' });
	// A provider's own dump request is replaced, never appended to.
	assert.deepEqual(
		gccControlFlowGraphOutput.arguments(outputFile, path.join(temporary, 'coglens'), [
			'-fdump-tree-cfg=provider.cfg',
		]),
		['-c', `-fdump-tree-cfg=${outputFile}`, '-o', path.join(temporary, 'coglens', 'output.o')],
	);
});

test('Rust arguments supply a crate identity only when the project does not', () => {
	assert.deepEqual(rustArtifactArguments('mir', 'artifact.mir', []), [
		'--crate-name=coglens_artifact',
		'--crate-type=lib',
		'--emit=mir=artifact.mir',
		'--error-format=human',
		'--color=never',
	]);
	assert.deepEqual(rustArtifactArguments('llvm-ir', 'artifact.ll', ['--crate-name=real', '--crate-type', 'rlib']), [
		'--emit=llvm-ir=artifact.ll',
		'-C',
		'debuginfo=1',
		'--error-format=human',
		'--color=never',
	]);
	assert.deepEqual(rustOutputArguments('assembly', 'output.s', ['--edition=2021']), [
		'--crate-name=coglens_artifact',
		'--crate-type=lib',
		'--emit=asm',
		'-C',
		'debuginfo=1',
		'--error-format=human',
		'--color=never',
		'-o',
		'output.s',
	]);

	const object = rustOutputArguments('object', 'output.o', []);
	assert.ok(object.includes('--emit=obj') && !object.includes('--emit=asm'));
	const project = rustOutputArguments('assembly', 'output.s', ['--crate-name', 'application', '--crate-type=bin']);
	assert.ok(!project.includes('--crate-name=coglens_artifact') && !project.includes('--crate-type=lib'));
});

test('Zig and nvcc emit through their own build drivers', () => {
	assert.deepEqual(zigOutputArguments('assembly', 'out.s'), [
		'build-obj',
		'-fllvm',
		'-fno-strip',
		'-fno-emit-bin',
		'-femit-asm=out.s',
	]);
	assert.deepEqual(nvccOutputArguments('assembly', 'out.ptx'), [
		'--ptx',
		'--generate-line-info',
		'--keep-device-functions',
		'-o',
		'out.ptx',
	]);
	assert.deepEqual(nvccOutputArguments('object', 'out.cubin'), [
		'--cubin',
		'--generate-line-info',
		'--keep-device-functions',
		'-o',
		'out.cubin',
	]);
});

test('dependency collection names its own output and keeps the project crate identity', () => {
	const gcc = getToolchainDefinition('gcc').dependencyCollection;
	assert.ok(gcc);
	assert.equal(gcc.outputFilename, 'dependencies.d');
	assert.deepEqual(gcc.arguments('deps.d', temporary, ['-O2']), ['-M', '-MF', 'deps.d']);

	const msvc = getToolchainDefinition('msvc').dependencyCollection;
	assert.ok(msvc);
	assert.equal(msvc.outputFilename, 'dependencies.json');
	assert.deepEqual(msvc.arguments('deps.json', temporary, ['/O2']).slice(0, 3), [
		'/c',
		'/sourceDependencies',
		'deps.json',
	]);

	const rust = getToolchainDefinition('rust').dependencyCollection;
	assert.ok(rust);
	assert.deepEqual(rust.arguments('deps.d', temporary, ['--crate-name=real']), [
		'--crate-type=lib',
		'--emit=dep-info=deps.d',
		'--error-format=human',
		'--color=never',
	]);
	assert.equal(getToolchainDefinition('python').dependencyCollection, undefined);
});

test('Intel syntax arguments appear only where the syntax is selectable', () => {
	assert.deepEqual(intelOutputArguments(toolchainDefinitions.gcc, { intel: true, demangle: false }), ['-masm=intel']);
	assert.deepEqual(intelOutputArguments(toolchainDefinitions.gcc, { intel: false, demangle: false }), []);
	assert.deepEqual(intelOutputArguments(toolchainDefinitions.rust, { intel: true, demangle: false }), [
		'-C',
		'llvm-args=-x86-asm-syntax=intel',
	]);
	// MSVC emits Intel syntax inherently, so it contributes no argument.
	assert.deepEqual(intelOutputArguments(toolchainDefinitions.msvc, { intel: true, demangle: false }), []);
	assert.deepEqual(
		intelOutputArguments(
			{ intelSyntax: 'selectable', intelArguments: undefined },
			{ intel: true, demangle: false },
		),
		[],
	);
});

test('CMake include paths and definitions are flattened with each toolchain own flags', () => {
	for (const kind of supportedToolchainKinds) {
		const definition = getToolchainDefinition(kind);
		assert.deepEqual(
			flattenCmakeArguments(['-O2'], ['include'], ['VALUE=1'], kind),
			[
				'-O2',
				...(definition.includeFlag ? [`${definition.includeFlag}include`] : []),
				...(definition.defineFlag ? [`${definition.defineFlag}VALUE=1`] : []),
			],
			kind,
		);
	}
});
