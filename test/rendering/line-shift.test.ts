import assert from 'node:assert/strict';
import test from 'node:test';
import { LineShift, shiftedLine, type LineChange } from '../../src/artifact-document/line-shift.js';

function change(
	startLine: number,
	startCharacter: number,
	endLine: number,
	endCharacter: number,
	text: string,
): LineChange {
	return {
		range: {
			start: { line: startLine, character: startCharacter },
			end: { line: endLine, character: endCharacter },
		},
		text,
	};
}

test('a line moves with its start', () => {
	// Typing in a line keeps it and the lines after it in place.
	assert.equal(shiftedLine(4, change(4, 3, 4, 3, 'x')), 4);
	assert.equal(shiftedLine(9, change(4, 3, 4, 3, 'x')), 9);
	// Enter at the end of a line adds a line after it.
	assert.equal(shiftedLine(4, change(4, 10, 4, 10, '\n')), 4);
	assert.equal(shiftedLine(5, change(4, 10, 4, 10, '\n')), 6);
	// Enter at the start of a line moves the line down.
	assert.equal(shiftedLine(4, change(4, 0, 4, 0, '\r\n')), 5);
	assert.equal(shiftedLine(3, change(4, 0, 4, 0, '\n')), 3);
	// A deleted line and its line break are gone, and the lines after it move up.
	assert.equal(shiftedLine(4, change(4, 0, 5, 0, '')), undefined);
	assert.equal(shiftedLine(5, change(4, 0, 5, 0, '')), 4);
	assert.equal(shiftedLine(8, change(4, 0, 5, 0, '')), 7);
	// A deletion from the middle of one line into a later line joins them. The first keeps its place.
	assert.equal(shiftedLine(4, change(4, 6, 6, 2, '')), 4);
	assert.equal(shiftedLine(5, change(4, 6, 6, 2, '')), undefined);
	assert.equal(shiftedLine(6, change(4, 6, 6, 2, '')), undefined);
	assert.equal(shiftedLine(7, change(4, 6, 6, 2, '')), 5);
	// A paste of three lines into a line moves the lines after it down by three.
	assert.equal(shiftedLine(4, change(4, 2, 4, 2, 'a\nb\nc\n')), 4);
	assert.equal(shiftedLine(5, change(4, 2, 4, 2, 'a\nb\nc\n')), 8);
	// Text that replaces the start of a line keeps the rest of the line on that line.
	assert.equal(shiftedLine(4, change(4, 0, 4, 5, 'int')), 4);
});

test('a line shift applies the changes of each event in their order', () => {
	const shift = new LineShift([0, 2, 5, 9]);
	assert.equal(shift.isIdentity, true);
	shift.apply([change(1, 0, 1, 0, 'int added;\n')]);
	assert.equal(shift.isIdentity, false);
	// Each range of an event refers to the text after the changes before it.
	shift.apply([change(10, 0, 11, 0, ''), change(0, 0, 0, 0, '// note\n')]);
	assert.deepEqual(
		[0, 2, 5, 9].map((line) => shift.lineOf(line)),
		[1, 4, 7, undefined],
	);
	assert.equal(shift.lineOf(3), undefined, 'A line that the shift was not made with has no place');
});

test('a line shift without a moving change stays the identity', () => {
	const shift = new LineShift([3, 7]);
	shift.apply([change(7, 4, 7, 4, 'x'), change(10, 0, 12, 0, '')]);
	assert.equal(shift.isIdentity, true);
	assert.equal(shift.lineOf(7), 7);
});
