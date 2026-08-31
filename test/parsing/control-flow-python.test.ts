import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePythonControlFlowGraphs } from '../../src/artifacts/control-flow-graph/parsers/python-cfg-parser.js';

/** One entry of the isolated helper's JSON payload, with only the fields a case varies. */
function instruction(offset: number, overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
	return {
		offset,
		opname: 'NOP',
		argrepr: '',
		startsLine: 1,
		line: 1,
		endLine: 1,
		column: 0,
		endColumn: 1,
		isJumpTarget: false,
		isJump: false,
		conditional: false,
		target: null,
		terminal: false,
		return: false,
		...overrides,
	};
}

function payload(...codeObjects: readonly Record<string, unknown>[]): string {
	return JSON.stringify({ codeObjects });
}

function codeObject(
	name: string,
	instructions: readonly unknown[],
	exceptions: readonly unknown[] = [],
): Record<string, unknown> {
	return { name, filename: 'source.py', firstLine: 1, instructions, exceptions };
}

const returnValue = { opname: 'RETURN_VALUE', terminal: true, return: true } as const;

test('nested code objects become separate graphs and a malformed one is reported', () => {
	const result = parsePythonControlFlowGraphs(
		payload(
			codeObject(
				'<module>',
				[
					instruction(0, {
						opname: 'POP_JUMP_FORWARD_IF_FALSE',
						argrepr: 'to 4',
						isJump: true,
						conditional: true,
						target: 4,
						startsLine: 1,
						line: 1,
					}),
					instruction(2, returnValue),
					instruction(4, { ...returnValue, isJumpTarget: true }),
				],
				[{ start: 0, end: 2, target: 4, depth: 1, lasti: false }],
			),
			codeObject('nested', []),
			{ name: 'malformed' },
		),
		'/project',
	);

	// The code object with no instructions is unusable and is reported once.
	assert.equal(result.graphs.length, 2);
	assert.equal(result.diagnostics.length, 1);
	const [module] = result.graphs;
	assert.equal(module.label, '<module>');
	assert.equal(module.edges.find((edge) => edge.to === 'offset:2')?.kind, 'true');
	assert.equal(module.edges.find((edge) => edge.to === 'offset:4' && edge.kind !== 'exception')?.kind, 'false');
	assert.ok(module.edges.some((edge) => edge.kind === 'exception'));
	assert.ok(module.nodes.some((node) => node.terminal === 'return'));
	assert.deepEqual(module.nodes[0].referencedArtifactLines, [0]);
	assert.equal(module.nodes[0].source?.line, 0);
});

test('unknown jump and exception targets are reported, and ranges split at the next instruction', () => {
	const missingJumpTarget = 99;
	const missingExceptionTarget = 88;
	const result = parsePythonControlFlowGraphs(
		payload(
			codeObject(
				'boundary',
				[
					instruction(0),
					instruction(2),
					instruction(4),
					instruction(8, { ...returnValue, isJumpTarget: true }),
				],
				// The range ends mid-instruction, so the block boundary lands on offset 4.
				[{ start: 0, end: 3, target: 8, depth: 0, lasti: false }],
			),
			codeObject(
				'partial',
				[
					instruction(0, { opname: 'JUMP_FORWARD', isJump: true, target: missingJumpTarget }),
					instruction(2, returnValue),
				],
				[{ start: 0, end: 2, target: missingExceptionTarget, depth: 1, lasti: true }],
			),
		),
		'/project',
	);

	assert.equal(result.graphs.length, 1);
	const [boundary] = result.graphs;
	assert.deepEqual(
		boundary.nodes.map((node) => node.id),
		['offset:0', 'offset:4', 'offset:8'],
	);
	assert.deepEqual(boundary.nodes[1].referencedArtifactLines, [4]);

	// Both dangling targets are reported against the code object that holds them.
	assert.ok(result.diagnostics.every((message) => message.includes(JSON.stringify('partial'))));
	for (const target of [missingJumpTarget, missingExceptionTarget]) {
		assert.ok(
			result.diagnostics.some((message) => message.includes(String(target))),
			`target ${target} was not reported`,
		);
	}
});

test('source filenames resolve to URIs independently of the host path style', () => {
	const uriFor = (filename: string, workingDirectory: string) =>
		parsePythonControlFlowGraphs(
			JSON.stringify({
				codeObjects: [
					{
						name: 'source',
						filename,
						firstLine: 1,
						instructions: [instruction(0, returnValue)],
						exceptions: [],
					},
				],
			}),
			workingDirectory,
		).graphs[0].nodes[0].source?.uri;

	assert.equal(uriFor('src/file name.py', '/project'), 'file:///project/src/file%20name.py');
	assert.equal(uriFor('src\\file name.py', 'C:\\project'), 'file:///C:/project/src/file%20name.py');
	assert.equal(uriFor('/repo/src/file name.py', 'C:\\project'), 'file:///repo/src/file%20name.py');
	assert.equal(uriFor('C:\\repo\\src file.py', '/project'), 'file:///C:/repo/src%20file.py');
});
