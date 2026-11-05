import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { buildArtifactDetails } from '../src/artifacts/ui/artifact-details.js';
import {
	orderByRecentUse,
	partitionArtifactPickerChoices,
	recentArtifactKinds,
	withRecentUse,
} from '../src/artifacts/ui/artifact-picker.js';
import { emptyArtifactText } from '../src/artifacts/ui/empty-artifact.js';
import type { ArtifactDocumentSnapshot } from '../src/artifact-document/artifact-identity.js';
import type { ArtifactKind, CompileDiagnostic } from '../src/types/index.js';
import { sourceUri } from './support/toolchains.js';
import { textArtifact } from './support/artifacts.js';

const source = path.resolve('/project/main.cpp');

test('an empty listing names the filtered lines and the likely causes for C and C++', () => {
	const text = emptyArtifactText(
		{ kind: 'assembly', metrics: { filteredLineCount: 42 } },
		{ sourceLabel: source, toolchainKind: 'gcc' },
	);
	assert.match(text, /^The compiler made no Assembly output for main\.cpp\./u);
	assert.match(text, /removed all 42 lines of the output/u);
	assert.match(text, /static or inline/u);
	assert.match(text, /template/u);
	assert.match(text, /"Show library code" is off/u);
});

test('an empty listing gives the causes of its toolchain and kind', () => {
	const rust = emptyArtifactText({ kind: 'assembly', metrics: {} }, { sourceLabel: source, toolchainKind: 'rust' });
	assert.match(rust, /Make it pub/u);
	assert.doesNotMatch(rust, /removed all/u, 'No filtered lines, so no filter text');

	// LLVM IR has no library code option, so it does not name one.
	const ir = emptyArtifactText({ kind: 'llvm-ir', metrics: {} }, { sourceLabel: source, toolchainKind: 'clang' });
	assert.doesNotMatch(ir, /Show library code/u);
	assert.match(ir, /static or inline/u);

	const remarks = emptyArtifactText(
		{ kind: 'optimization-remarks', metrics: {} },
		{ sourceLabel: source, toolchainKind: 'clang' },
	);
	assert.equal(remarks, 'The compiler reported no optimization remarks for main.cpp.');

	const python = emptyArtifactText(
		{ kind: 'assembly', metrics: { filteredLineCount: 1 } },
		{ sourceLabel: source, toolchainKind: 'python' },
	);
	assert.match(python, /removed all 1 line of/u);
	assert.doesNotMatch(python, /template/u);
});

test('the artifact picker puts recently used kinds first and keeps the other kinds in order', () => {
	const choice = (artifactKind: ArtifactKind) => ({
		artifactKind,
		label: artifactKind,
		availability: { status: 'available' } as const,
	});
	const choices = [choice('assembly'), choice('binary-disassembly'), choice('llvm-ir'), choice('ast')];
	assert.deepEqual(
		orderByRecentUse(choices, ['llvm-ir', 'ast']).map((candidate) => candidate.artifactKind),
		['llvm-ir', 'ast', 'assembly', 'binary-disassembly'],
	);
	assert.deepEqual(
		partitionArtifactPickerChoices(choices, ['ast']).available.map((candidate) => candidate.artifactKind),
		['ast', 'assembly', 'binary-disassembly', 'llvm-ir'],
	);

	assert.deepEqual(withRecentUse(['assembly', 'ast'], 'ast'), ['ast', 'assembly']);
	assert.deepEqual(withRecentUse([], 'llvm-ir'), ['llvm-ir']);
	assert.deepEqual(recentArtifactKinds(['ast', 'unknown', 3, 'ast', 'assembly']), ['ast', 'assembly']);
	assert.deepEqual(recentArtifactKinds('assembly'), []);
});

test('artifact details list each diagnostic with its severity and location', () => {
	const diagnostic = (severity: CompileDiagnostic['severity'], line: number, message: string): CompileDiagnostic => ({
		uri: sourceUri(source),
		line,
		column: 4,
		severity,
		message,
	});
	const snapshot = (diagnostics: readonly CompileDiagnostic[]): ArtifactDocumentSnapshot => ({
		identity: {
			documentUri: 'coglens-artifact:/project/main.coglens.asm',
			sourceUri: sourceUri(source).toString(),
			sourceLabel: source,
			artifactKind: 'assembly',
			artifactLabel: 'Assembly',
			presetId: 'default',
			variantId: 'variant',
			variantLabel: 'Variant',
			toolchainId: 'gcc',
			toolchainLabel: 'GCC',
			toolchainKind: 'gcc',
		},
		status: {
			state: 'successful',
			artifact: { ...textArtifact('assembly', []), diagnostics },
			truncated: false,
		},
	});

	const details = buildArtifactDetails(
		snapshot([diagnostic('warning', 0, 'unused variable'), diagnostic('error', 9, 'expected ";"')]),
	);
	assert.deepEqual(
		details.map((item) => item.label),
		['Artifact', 'Status', 'Diagnostics', 'Invocation', 'Environment', 'Metrics'],
	);
	const listed = details.find((item) => item.id === 'diagnostics')?.children;
	assert.deepEqual(
		listed?.map((item) => [item.label, item.value]),
		[
			['Warning · main.cpp:1:5', 'unused variable'],
			['Error · main.cpp:10:5', 'expected ";"'],
		],
	);
	assert.deepEqual(
		buildArtifactDetails(snapshot([]))
			.find((item) => item.id === 'diagnostics')
			?.children?.map((item) => item.label),
		['(none)'],
	);
});
