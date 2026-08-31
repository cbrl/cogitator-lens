import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { parseGccOptimizationRemarks } from '../../src/artifacts/optimization-remarks/gcc-optimization-remarks.js';
import { readFixture } from '../support/environment.js';

test('GCC optimization info normalizes relative locations and pass families', () => {
	const project = path.resolve('/project');
	const remarks = parseGccOptimizationRemarks(readFixture('optimization-remarks', 'gcc.opt'), project);

	assert.deepEqual(
		remarks.map((remark) => ({ ...remark, file: path.relative(project, remark.file!) })),
		[
			{
				file: path.join('src', 'source.cpp'),
				line: 8,
				column: 3,
				pass: 'vectorizer',
				category: 'passed',
				message: 'loop vectorized using 16 byte vectors',
			},
			{
				file: path.join('src', 'source.cpp'),
				line: 14,
				column: 9,
				pass: 'inliner',
				category: 'missed',
				message: 'not inlining call to external',
			},
			{
				file: path.join('src', 'source.cpp'),
				line: 20,
				column: 2,
				pass: 'loop',
				category: 'analysis',
				message: 'loop turned into non-loop; it never loops',
			},
		],
	);
});
