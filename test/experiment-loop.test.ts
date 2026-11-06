import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { functionCalls, linkAt, linksTo } from '../src/artifacts/core/artifact-calls.js';
import {
	applyArtifactView,
	functionListing,
	functionRanges,
	listingWithColumns,
	normalizedListing,
} from '../src/artifacts/core/artifact-views.js';
import { registerFamily } from '../src/artifacts/core/register-families.js';
import { annotationShows, sourceLineAnnotations } from '../src/artifacts/core/source-annotations.js';
import {
	functionSummaries,
	isExceptionFunclet,
	linesFromSource,
	previewText,
} from '../src/artifacts/core/source-summary.js';
import { llvmIrLinks } from '../src/artifacts/llvm-ir/llvm-ir-links.js';
import {
	argumentDialect,
	parseToolchainComparisonVariantId,
	toolchainComparisonVariant,
	toolchainComparisonVariantId,
} from '../src/compilation/comparison-variants.js';
import { formatCommandLine, tokenizeCommandLine } from '../src/tokenize.js';
import {
	gccOptimizationLevels,
	msvcOptimizationLevels,
	rustOptimizationLevels,
	selectedOptimizationLevel,
	withOptimizationLevel,
} from '../src/toolchains/optimization-levels.js';
import { toolchainDefinitions } from '../src/toolchains/toolchain-map.js';
import type {
	ArtifactLineAnnotation,
	CompilationVariant,
	OptimizationRemarkCategory,
	RenderedArtifactLine,
} from '../src/types/index.js';
import { textArtifact } from './support/artifacts.js';
import { sourceUri, toolchainProfile } from './support/toolchains.js';

const sourceFile = path.resolve('/project/main.cpp');
const mapped = (text: string, line: number, extra: Partial<RenderedArtifactLine> = {}): RenderedArtifactLine => ({
	text,
	source: { file: sourceFile, line },
	...extra,
});

test('an optimization level replaces the earlier level and keeps the other arguments', () => {
	assert.equal(selectedOptimizationLevel(['-O1', '-g', '-O3'], gccOptimizationLevels)?.label, '-O3');
	assert.equal(selectedOptimizationLevel(['-g'], gccOptimizationLevels), undefined);
	const o2 = gccOptimizationLevels.find((level) => level.label === '-O2');
	assert.deepEqual(withOptimizationLevel(['-O0', '-g', '-Os'], gccOptimizationLevels, o2), ['-g', '-O2']);
	assert.deepEqual(withOptimizationLevel(['-O0', '-g'], gccOptimizationLevels, undefined), ['-g']);
	assert.deepEqual(withOptimizationLevel(['/Od', '/Zi'], msvcOptimizationLevels, msvcOptimizationLevels[2]), [
		'/Zi',
		'/O2',
	]);

	// rustc levels are two arguments, or one joined argument.
	const rustLevel = (label: string) => rustOptimizationLevels.find((level) => level.label === label);
	assert.equal(selectedOptimizationLevel(['-C', 'opt-level=1'], rustOptimizationLevels)?.label, 'opt-level=1');
	assert.equal(selectedOptimizationLevel(['-Copt-level=s'], rustOptimizationLevels)?.label, 'opt-level=s');
	assert.deepEqual(
		withOptimizationLevel(
			['-Copt-level=1', '--edition=2021', '-C', 'opt-level=0'],
			rustOptimizationLevels,
			rustLevel('opt-level=3'),
		),
		['--edition=2021', '-C', 'opt-level=3'],
	);
	// A `-C` before another codegen option stays.
	assert.deepEqual(withOptimizationLevel(['-C', 'debuginfo=2'], rustOptimizationLevels, undefined), [
		'-C',
		'debuginfo=2',
	]);
});

test('each toolchain with optimization levels has a dialect that a comparison can use', () => {
	assert.equal(argumentDialect('gcc'), argumentDialect('clang'));
	assert.equal(argumentDialect('clang'), argumentDialect('apple-clang'));
	assert.equal(argumentDialect('msvc'), argumentDialect('clang-cl'));
	assert.notEqual(argumentDialect('gcc'), argumentDialect('msvc'));
	assert.equal(argumentDialect('rust'), 'rust');
	for (const kind of ['gcc', 'clang', 'clang-cl', 'msvc', 'rust', 'zig', 'python', 'dotnet'] as const) {
		assert.ok(toolchainDefinitions[kind].optimizationLevels?.length, kind);
	}
	assert.equal(toolchainDefinitions.go.optimizationLevels, undefined);
});

test('a command line reads back to the same arguments', () => {
	const args = ['-O2', '-DNAME="a b"', 'C:\\Program Files\\inc', 'with space', "it's", '', 'trailing\\'];
	for (const platform of ['posix', 'windows'] as const) {
		assert.deepEqual(tokenizeCommandLine(formatCommandLine(args, platform), platform), args, platform);
	}
	assert.equal(formatCommandLine(['-O2', '-g'], 'posix'), '-O2 -g');
	assert.equal(formatCommandLine(['-IC:\\include'], 'windows'), '-IC:\\include');
});

test('a comparison variant keeps the arguments only for a toolchain of the same dialect', () => {
	const base: CompilationVariant = {
		id: 'cmake:app|main',
		provider: 'cmake',
		source: sourceUri(sourceFile),
		toolchainProfileId: 'cmake:gcc',
		workingDirectory: path.resolve('/project/build'),
		arguments: ['-Iinclude', '-DDEBUG'],
		environment: { CCACHE_DIR: '/tmp' },
		displayLabel: 'app (Debug)',
	};
	const clang = toolchainProfile('clang', { id: 'path:clang' });
	const kept = toolchainComparisonVariant(base, 'gcc', clang);
	assert.equal(kept.argumentsDropped, false);
	assert.deepEqual(kept.variant.arguments, base.arguments);
	assert.deepEqual(kept.variant.environment, base.environment);
	assert.equal(kept.variant.workingDirectory, base.workingDirectory);
	assert.equal(kept.variant.toolchainProfileId, 'path:clang');

	const msvc = toolchainProfile('msvc', { id: 'user:cl' });
	const dropped = toolchainComparisonVariant(base, 'gcc', msvc);
	assert.equal(dropped.argumentsDropped, true);
	assert.deepEqual(dropped.variant.arguments, []);
	assert.deepEqual(dropped.variant.environment, {});

	assert.deepEqual(parseToolchainComparisonVariantId(kept.variant.id), {
		toolchainProfileId: 'path:clang',
		baseVariantId: base.id,
	});
	assert.equal(kept.variant.id, toolchainComparisonVariantId('path:clang', base.id));
	assert.equal(parseToolchainComparisonVariantId('cmake:app|main'), undefined);
	assert.equal(parseToolchainComparisonVariantId('compare:%E0%A4%A:x'), undefined);
});

/** Two functions: `main` calls `helper`, and `helper` has a loop. */
function twoFunctions() {
	const artifact = textArtifact('assembly', [
		{ text: 'helper:' },
		mapped('.LBB0_2:', 2),
		mapped('        add     eax, 1', 3),
		mapped('        jne     .LBB0_2', 3),
		mapped('        ret', 4),
		{ text: '' },
		{ text: 'main:' },
		mapped('        call    helper', 7),
		mapped('        jmp     .LBB1_4', 7),
		mapped('.LBB1_4:', 8),
		mapped('        ret', 8),
	]);
	return {
		...artifact,
		symbols: [
			{ name: 'helper', line: 0 },
			{ name: 'main', line: 6 },
		],
		folds: [],
		links: [
			{ line: 3, startCharacter: 16, endCharacter: 23, targetLine: 1, edgeKind: 'true' as const },
			{ line: 7, startCharacter: 16, endCharacter: 22, targetLine: 0 },
			{ line: 8, startCharacter: 16, endCharacter: 23, targetLine: 9, edgeKind: 'unconditional' as const },
		],
	};
}

test('a function listing keeps the lines and the links of one function', () => {
	const artifact = twoFunctions();
	assert.deepEqual(
		functionRanges(artifact).map((range) => [range.name, range.startLine, range.endLine]),
		[
			['helper', 0, 4],
			['main', 6, 10],
		],
	);
	const main = functionListing(artifact, 'main');
	assert.deepEqual(
		main.lines.map((line) => line.text.trim()),
		['main:', 'call    helper', 'jmp     .LBB1_4', '.LBB1_4:', 'ret'],
	);
	// The call leaves the function, so its link goes. The jump stays and moves with the lines.
	assert.deepEqual(main.links, [
		{ line: 2, startCharacter: 16, endCharacter: 23, targetLine: 3, edgeKind: 'unconditional' },
	]);
	assert.deepEqual(main.symbols, [{ name: 'main', line: 0 }]);
	assert.deepEqual(main.metrics, {});

	const missing = functionListing(artifact, 'absent');
	assert.deepEqual(
		missing.lines.map((line) => line.text),
		['The function "absent" is not in this listing.'],
	);
	assert.equal(applyArtifactView(artifact, undefined), artifact);
});

test('a normalized listing renumbers local labels in each function and keeps the link columns', () => {
	const input = twoFunctions();
	const artifact = normalizedListing(input);
	assert.deepEqual(
		artifact.lines.map((line) => line.text.trim()),
		[
			'helper:',
			'.LBB#1:',
			'add     eax, 1',
			'jne     .LBB#1',
			'ret',
			'',
			'main:',
			'call    helper',
			'jmp     .LBB#1',
			'.LBB#1:',
			'ret',
		],
	);
	// `.LBB0_2` became `.LBB#1`, which is one character shorter, so the link ends one column earlier.
	assert.deepEqual(artifact.links[0], { ...input.links[0], endCharacter: 22 });
	assert.equal(artifact.lines[2], input.lines[2], 'A line without a change stays the same object');

	const disassembly = normalizedListing(
		textArtifact('binary-disassembly', [
			{ text: 'call   401020 <helper>' },
			{ text: 'jmp    0x40102f <main+0x1f>' },
			{ text: 'add    rsp, 0x10' },
		]),
	);
	assert.deepEqual(
		disassembly.lines.map((line) => line.text),
		['call   ADDR <helper>', 'jmp    ADDR <main+OFF>', 'add    rsp, 0x10'],
	);

	const ir = normalizedListing({
		...textArtifact('llvm-ir', [
			{ text: 'define i32 @f(i32 %0) {' },
			{ text: '  %2 = add i32 %0, 1, !dbg !17' },
			{ text: '  br label %5' },
		]),
		symbols: [{ name: 'f', line: 0 }],
		links: [{ line: 2, startCharacter: 12, endCharacter: 14, targetLine: 1 }],
	});
	assert.deepEqual(
		ir.lines.map((line) => line.text),
		['define i32 @f(i32 %#1) {', '  %#2 = add i32 %#1, 1, !dbg !#1', '  br label %#3'],
	);
	// `%5` became `%#3`, so the link grows by one column.
	assert.deepEqual(ir.links[0], { line: 2, startCharacter: 12, endCharacter: 15, targetLine: 1 });
});

test('copied lines carry their address and code byte columns', () => {
	const artifact = textArtifact('binary-disassembly', [
		{ text: 'push   rbp', address: 0x401000, opcodes: ['55'] },
		{ text: 'mov    rbp, rsp', address: 0x401001, opcodes: ['48', '89', 'e5'] },
		{ text: 'main:' },
	]);
	assert.equal(
		listingWithColumns(artifact, [0, 1, 2]),
		['401000  55        push   rbp', '401001  48 89 e5  mov    rbp, rsp', '                  main:'].join('\n'),
	);
});

test('the source summary finds the lines and the functions of a source line', () => {
	const artifact = twoFunctions();
	assert.deepEqual(linesFromSource(artifact, sourceFile, 2), [2, 3]);
	assert.deepEqual(linesFromSource(artifact, path.resolve('/project/other.cpp'), 2), []);
	assert.deepEqual(
		functionSummaries(artifact, sourceFile).map((summary) => [
			summary.name,
			summary.sourceLine,
			summary.instructionCount,
		]),
		[
			['helper', 1, 4],
			['main', 6, 4],
		],
	);
	// Inlined code from an earlier line, such as a derive attribute, does not move the function.
	const inlined = {
		...textArtifact('assembly', [{ text: 'analyze:' }, mapped('push rbp', 18), mapped('mov eax, 1', 1)]),
		symbols: [{ name: 'analyze', line: 0 }],
	};
	assert.equal(functionSummaries(inlined, sourceFile)[0]?.sourceLine, 17);
	assert.equal(isExceptionFunclet('?catch$6@?0?coglens_sample_entry@4HA'), true);
	assert.equal(isExceptionFunclet('?dtor$3@?0?main@4HA'), true);
	assert.equal(isExceptionFunclet('?main@@YAHXZ'), false);
	assert.equal(
		previewText(artifact, [2, 3, 7], 10),
		'        add     eax, 1\n        jne     .LBB0_2\n…\n        call    helper',
	);
	assert.equal(previewText(artifact, [2, 3, 4], 2), '        add     eax, 1\n        jne     .LBB0_2\n… 1 more line');
});

test('the call graph and the references come from the links of the listing', () => {
	const artifact = twoFunctions();
	const calls = functionCalls(artifact);
	assert.deepEqual(
		calls.map((call) => [call.caller.name, call.callee.name, call.links.length]),
		[['main', 'helper', 1]],
	);
	assert.deepEqual(
		linksTo(artifact, 1).map((link) => link.line),
		[3],
	);
	assert.equal(linkAt(artifact, 7, 18)?.targetLine, 0);
	assert.equal(linkAt(artifact, 7, 2), undefined);
});

test('register families join the views of one register', () => {
	for (const name of ['rax', 'eax', 'ax', 'al', 'ah', '%RAX']) {
		assert.equal(registerFamily(name), 'rax', name);
	}
	assert.equal(registerFamily('r9d'), 'r9');
	assert.equal(registerFamily('ymm3'), 'xmm3');
	assert.equal(registerFamily('w7'), 'x7');
	assert.equal(registerFamily('q2'), 'v2');
	assert.equal(registerFamily('main'), undefined);
	assert.equal(registerFamily('x31'), undefined);
});

test('LLVM IR links go to labels, local values, and globals', () => {
	const lines: RenderedArtifactLine[] = [
		{ text: '@g = global i32 0' },
		{ text: 'define i32 @f(i32 %0) {' },
		{ text: '  %2 = icmp eq i32 %0, 0' },
		{ text: '  br i1 %2, label %3, label %4' },
		{ text: '3:                                                ; preds = %1' },
		{ text: '  %v = load i32, ptr @g' },
		{ text: '  br label %4' },
		{ text: '4:' },
		{ text: '  ret i32 %0' },
		{ text: '}' },
	];
	const links = llvmIrLinks(lines, [{ name: 'f', line: 1 }], [{ startLine: 1, endLine: 9 }]);
	const linkText = (link: (typeof links)[number]) =>
		lines[link.line].text.slice(link.startCharacter, link.endCharacter);
	assert.deepEqual(
		links.map((link) => [link.line, linkText(link), link.targetLine, link.edgeKind]),
		[
			[2, '%0', 1, undefined],
			[3, '%2', 2, undefined],
			[3, '%3', 4, 'true'],
			[3, '%4', 7, undefined],
			[5, '@g', 0, undefined],
			[6, '%4', 7, 'unconditional'],
			[8, '%0', 1, undefined],
		],
	);
});

test('source annotations group the remarks of a source line and obey the category filter', () => {
	const remark = (category: OptimizationRemarkCategory, text: string): ArtifactLineAnnotation => ({
		kind: 'optimization-remark',
		category,
		message: text,
		text,
		style: `optimization-${category}`,
	});
	const artifact = textArtifact('optimization-remarks', [
		mapped('int f() {', 1, { annotations: [remark('passed', 'inlined g'), remark('passed', 'inlined g')] }),
		mapped('  return g();', 2, { annotations: [remark('missed', 'not vectorized')] }),
		{ text: 'unmapped', annotations: [remark('passed', 'lost')] },
	]);
	const all = new Set<OptimizationRemarkCategory>(['passed', 'missed', 'analysis']);
	assert.deepEqual(sourceLineAnnotations(artifact, sourceFile, all), [
		{ line: 0, style: 'optimization-passed', texts: ['inlined g'] },
		{ line: 1, style: 'optimization-missed', texts: ['not vectorized'] },
	]);
	assert.deepEqual(
		sourceLineAnnotations(artifact, sourceFile, new Set(['missed'])).map((annotation) => annotation.line),
		[1],
	);
	const stack: ArtifactLineAnnotation = {
		kind: 'stack-usage',
		functionName: 'f',
		value: 16,
		unit: 'bytes',
		qualifier: 'static',
		text: '16 bytes',
		style: 'stack-usage',
	};
	assert.equal(annotationShows(stack, new Set()), true, 'The filter applies to remarks only');
});
