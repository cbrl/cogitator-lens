import assert from 'node:assert/strict';
import test from 'node:test';
import type { ArtifactStatus } from '../src/artifact-document/artifact-generator.js';
import type { ArtifactDocumentSnapshot } from '../src/artifact-document/artifact-identity.js';
import {
	documentationForInstruction,
	instructionMnemonic,
	instructionSetLabels,
	type InstructionDocumentation,
} from '../src/artifact-document/instruction-documentation.js';
import {
	artifactScrollAnchor,
	ScrollSyncSuppression,
	sourceDensityLevel,
	sourceLineBandIndex,
	sourceScrollAnchor,
} from '../src/artifact-document/source-bridge.js';
import { jumpArrows } from '../src/artifact-document/jump-arrows.js';
import type { ArtifactDetailsItem } from '../src/artifacts/ui/artifact-details.js';
import { partitionArtifactPickerChoices } from '../src/artifacts/ui/artifact-picker.js';
import type { InvocationDetails, RawArtifact, RenderedArtifact } from '../src/types/index.js';
import { textArtifact } from './support/artifacts.js';

/** One invocation, shared so the details rows and command-line quoting describe the same input. */
const compilerInvocation: InvocationDetails = {
	executable: '/tool chain/clang++',
	args: ['-O2', '-DNAME=value with spaces'],
	environmentVariableNames: ['API_KEY', 'TOKEN'],
	cwd: '/project',
};

const generatedAt = 1_700_000_000_000;
const durationMs = 12.4;
const largestFrame = 64;

test('the artifact picker hides unsupported choices and separates unavailable ones', () => {
	const sections = partitionArtifactPickerChoices([
		{ artifactKind: 'assembly', label: 'Assembly', availability: { status: 'available' } },
		{
			artifactKind: 'binary-disassembly',
			label: 'Binary disassembly',
			availability: { status: 'unavailable', explanation: 'No disassembler was detected.' },
		},
		{
			artifactKind: 'ast',
			label: 'Abstract syntax tree',
			availability: { status: 'unsupported', explanation: 'This toolchain has no AST producer.' },
		},
	]);

	assert.deepEqual(
		sections.available.map((choice) => choice.artifactKind),
		['assembly'],
	);
	assert.deepEqual(
		sections.unavailable.map((choice) => choice.artifactKind),
		['binary-disassembly'],
	);
});

test('instruction documentation is chosen from the instruction set the listing implies', () => {
	const assembly = textArtifact('assembly', [
		{ text: '  push rbp' },
		{ text: '  call helper' },
		{ text: '  vzeroupper' },
	]);
	assertDocuments(documentationForInstruction(assembly, 'call helper'), instructionSetLabels.amd64, 'call');
	assert.ok(documentationForInstruction(assembly, 'vzeroupper')?.tooltip);

	const aarch64 = textArtifact('assembly', [
		{ text: '  stp x29, x30, [sp, #-16]!' },
		{ text: '  adrp x0, symbol' },
		{ text: '  blr x8' },
	]);
	assertDocuments(documentationForInstruction(aarch64, aarch64.lines[0].text), instructionSetLabels.aarch64, 'stp');

	const riscv = textArtifact('binary-disassembly', [
		{ text: '0: 13 05 10 00 addi a0, zero, 1', disassembly: 'addi a0, zero, 1' },
		{ text: '4: 67 80 00 00 jalr zero, 0(ra)', disassembly: 'jalr zero, 0(ra)' },
	]);
	assertDocuments(
		documentationForInstruction(riscv, riscv.lines[0].disassembly ?? ''),
		instructionSetLabels.riscv64,
		'addi',
	);
});

test('LLVM IR and Python bytecode use their artifact-specific documentation tables', () => {
	const llvm = textArtifact('llvm-ir', [{ text: '  %sum = add i32 %left, %right' }]);
	assertDocuments(documentationForInstruction(llvm, llvm.lines[0].text), instructionSetLabels.llvmIr, 'add');
	assert.equal(instructionMnemonic(llvm, '  tail call void @work()'), 'call');

	const python = textArtifact(
		'assembly',
		[{ text: '  4          10 BINARY_OP                0 (+)' }],
		'python-bytecode',
	);
	assertDocuments(
		documentationForInstruction(python, python.lines[0].text),
		instructionSetLabels.pythonBytecode,
		'binary_op',
	);
});

test('.NET IL uses the CIL instruction documentation table', () => {
	const dotnetIl = textArtifact(
		'assembly',
		[
			{ text: 'IL_0000: ldarg.0' },
			{ text: 'IL_0001: callvirt instance string [System.Runtime]System.Object::ToString()' },
			{ text: 'IL_0006: ret' },
		],
		'dotnet-il',
	);
	assertDocuments(
		documentationForInstruction(dotnetIl, dotnetIl.lines[1].text),
		instructionSetLabels.dotNetIl,
		'callvirt',
	);
	assert.equal(instructionMnemonic(dotnetIl, dotnetIl.lines[0].text), 'ldarg.0');
	assert.equal(instructionMnemonic(dotnetIl, 'IL_0000: constrained. [System.Runtime]System.Object'), 'constrained.');
});

/**
 * Documentation is identified by the set it came from and the mnemonic it
 * documents; the prose and the upstream URL belong to the vendored tables.
 */
function assertDocuments(
	documentation: InstructionDocumentation | undefined,
	instructionSet: string,
	mnemonic: string,
): void {
	assert.ok(documentation, `no documentation for ${mnemonic}`);
	assert.equal(documentation.instructionSet, instructionSet);
	assert.equal(documentation.mnemonic, mnemonic);
	assert.ok(documentation.tooltip.length > 0, `${mnemonic} has no tooltip`);
	// The reference is a link into upstream documentation, whose wording and
	// anchor style belong to the vendored table rather than to this extension.
	assert.ok(documentation.url.startsWith('https://'), `${mnemonic} has no reference link`);
}

test('scroll synchronization anchors on the topmost visible mapped line in each direction', () => {
	const mapping = new Map<number, number[]>([
		[12, [30, 29]],
		[8, [21]],
		[10, [27, 25]],
	]);
	assert.deepEqual(sourceScrollAnchor(mapping, 9, 15), { sourceLine: 10, artifactLine: 25 });
	assert.equal(sourceScrollAnchor(mapping, 13, 20), undefined);

	const lines = [
		{},
		{ source: { file: 'before.cpp', line: 1 } },
		{},
		{ source: { file: 'main.cpp', line: 7 } },
		{ source: { file: 'main.cpp', line: 8 } },
	];
	assert.deepEqual(artifactScrollAnchor(lines, 2, 4), { file: 'main.cpp', sourceLine: 6, artifactLine: 3 });
	assert.equal(artifactScrollAnchor(lines, 0, 0), undefined);
});

test('scroll synchronization suppresses every target event until scrolling settles', async () => {
	const sourceEditor = {};
	const targetEditor = {};
	const suppression = new ScrollSyncSuppression<object>(10, 20);

	suppression.begin(targetEditor);
	assert.equal(suppression.shouldSuppress(sourceEditor), false);
	assert.equal(suppression.shouldSuppress(targetEditor), true);
	await new Promise((resolve) => setTimeout(resolve, 5));
	assert.equal(suppression.shouldSuppress(targetEditor), true);
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(suppression.shouldSuppress(targetEditor), false);

	suppression.dispose();
});

test('source density and source highlights share one repeating color band', () => {
	assert.deepEqual(
		[
			sourceDensityLevel(0, 10, 5),
			sourceDensityLevel(1, 5, 5),
			sourceDensityLevel(3, 5, 5),
			sourceDensityLevel(5, 5, 5),
			sourceDensityLevel(100, 5, 5),
		],
		[0, 0, 2, 4, 4],
	);
	assert.deepEqual(
		[sourceLineBandIndex(0, 6), sourceLineBandIndex(5, 6), sourceLineBandIndex(6, 6), sourceLineBandIndex(14, 6)],
		[0, 5, 0, 2],
	);
});

test('jump arrows classify forward branches and back edges from navigation links', () => {
	assert.deepEqual(
		jumpArrows(
			[
				{ line: 2, startCharacter: 4, endCharacter: 8, targetLine: 7, edgeKind: 'true' },
				{ line: 9, startCharacter: 4, endCharacter: 8, targetLine: 3, edgeKind: 'unconditional' },
				{ line: 4, startCharacter: 4, endCharacter: 8, targetLine: 4, edgeKind: 'true' },
				{ line: 12, startCharacter: 0, endCharacter: 2, targetLine: 1, edgeKind: 'unconditional' },
				{ line: 2, startCharacter: 9, endCharacter: 13, targetLine: 7, edgeKind: 'true' },
				{ line: 6, startCharacter: 4, endCharacter: 10, targetLine: 8 },
			],
			10,
		),
		[
			{ sourceLine: 2, targetLine: 7, direction: 'forward' },
			{ sourceLine: 4, targetLine: 4, direction: 'backward' },
			{ sourceLine: 9, targetLine: 3, direction: 'backward' },
		],
	);
});

function successfulStatus(withDiagnostics = true): ArtifactStatus {
	const diagnostics: RawArtifact['diagnostics'] = withDiagnostics
		? [
				{ uri: {} as never, line: 0, column: 0, severity: 'error', message: 'error' },
				{ uri: {} as never, line: 0, column: 0, severity: 'warning', message: 'warning' },
				{ uri: {} as never, line: 0, column: 0, severity: 'information', message: 'note' },
			]
		: [];
	const artifact: RenderedArtifact = {
		kind: 'stack-analysis',
		presentation: 'text',
		diagnostics,
		durationMs,
		generatedAt,
		command: compilerInvocation,
		lines: [],
		links: [],
		folds: [],
		symbols: [],
		metrics: { largestFrame, functionCount: 3 },
		truncated: false,
	};
	return { state: 'successful', artifact, truncated: false };
}

function snapshot(status: ArtifactStatus): ArtifactDocumentSnapshot {
	return {
		identity: {
			documentUri: 'coglens-artifact:/project/source.stack.cpp',
			sourceUri: 'file:///project/source.cpp',
			sourceLabel: '/project/source.cpp',
			artifactKind: 'stack-analysis',
			artifactLabel: 'Stack analysis',
			presetId: 'default',
			variantId: 'cmake:debug',
			variantLabel: 'Debug',
			toolchainId: 'cmake:clang',
			toolchainLabel: 'Clang 20',
			toolchainKind: 'clang',
		},
		status,
	};
}

function itemValue(items: readonly ArtifactDetailsItem[], id: string): string | undefined {
	return findItem(items, id).value;
}

function findItem(items: readonly ArtifactDetailsItem[], id: string): ArtifactDetailsItem {
	const found = tryFindItem(items, id);
	assert.ok(found, `Details item not found: ${id}`);
	return found;
}

function tryFindItem(items: readonly ArtifactDetailsItem[], id: string): ArtifactDetailsItem | undefined {
	for (const item of items) {
		if (item.id === id) {
			return item;
		}
		const nested = item.children ? tryFindItem(item.children, id) : undefined;
		if (nested) {
			return nested;
		}
	}
	return undefined;
}
