import assert from 'node:assert/strict';
import test from 'node:test';
import { partitionArtifactPickerChoices } from '../src/artifacts/ui/artifact-picker.js';

test('artifact picker hides unsupported choices and separates unavailable choices', () => {
	const sections = partitionArtifactPickerChoices([
		{
			artifactKind: 'assembly',
			label: 'Assembly',
			availability: { status: 'available' },
		},
		{
			artifactKind: 'binary-disassembly',
			label: 'Binary disassembly',
			availability: {
				status: 'unavailable',
				explanation: 'No disassembler was detected.',
			},
		},
		{
			artifactKind: 'python-bytecode',
			label: 'Python bytecode',
			availability: {
				status: 'unsupported',
				explanation: 'This toolchain has no Python bytecode producer.',
			},
		},
	]);

	assert.deepEqual(sections.available.map(choice => choice.artifactKind), ['assembly']);
	assert.deepEqual(
		sections.unavailable.map(choice => choice.artifactKind),
		['binary-disassembly'],
	);
	assert.ok(![...sections.available, ...sections.unavailable]
		.some(choice => choice.artifactKind === 'python-bytecode'));
});
