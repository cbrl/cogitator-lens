import assert from 'node:assert/strict';
import test from 'node:test';
import {
	ChangeLog,
	LineShift,
	changedCharacter,
	movedArtifact,
	shiftedLine,
	type LineChange,
} from '../../src/artifact-document/line-shift.js';
import type { RenderedArtifactLineSource, RenderedTextArtifact } from '../../src/types/index.js';

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

test('a line shift without a change of a known line stays the identity', () => {
	const shift = new LineShift([3, 7]);
	shift.apply([change(5, 4, 5, 4, 'x'), change(10, 0, 12, 0, '')]);
	assert.equal(shift.isIdentity, true);
	assert.equal(shift.lineOf(7), 7);
});

test('a change moves the characters of a line from its first changed character', () => {
	assert.equal(changedCharacter(4, change(4, 12, 4, 12, 'x')), 12, 'Typing moves the characters after it');
	assert.equal(changedCharacter(4, change(4, 10, 4, 10, '\n')), 10, 'Enter keeps the characters before it');
	assert.equal(changedCharacter(4, change(4, 0, 4, 0, '\n')), undefined, 'Enter at the start moves the whole line');
	assert.equal(changedCharacter(4, change(4, 0, 4, 0, 'int x;\r\n')), undefined);
	assert.equal(changedCharacter(4, change(4, 0, 4, 0, '\t')), 0, 'Text at the start moves each character');
	assert.equal(changedCharacter(4, change(4, 0, 4, 3, 'a\nb')), 0);
	// A deleted line before the line moves the line up with its columns.
	assert.equal(changedCharacter(5, change(4, 0, 5, 0, '')), undefined);
	// A deletion that joins the line to the line before it moves each character.
	assert.equal(changedCharacter(5, change(4, 6, 5, 0, '')), 0);
	assert.equal(changedCharacter(5, change(4, 6, 5, 0, ' ')), 0);
	assert.equal(changedCharacter(5, change(4, 2, 5, 0, 'a\n')), undefined);
	assert.equal(changedCharacter(4, change(5, 0, 5, 3, '')), undefined, 'A change of a later line');
	assert.equal(changedCharacter(4, change(2, 0, 2, 0, 'a\n')), undefined, 'A change of an earlier line');

	const shift = new LineShift([3, 7]);
	shift.apply([change(7, 12, 7, 12, 'x')]);
	assert.equal(shift.isIdentity, false, 'A moved character is a change');
	assert.equal(shift.lineOf(7), 7);
	assert.equal(shift.changedCharacterOf(7), 12);
	shift.apply([change(7, 4, 7, 6, ''), change(0, 0, 0, 0, '\n')]);
	assert.equal(shift.changedCharacterOf(7), 4, 'The first changed character of each change');
	assert.equal(shift.lineOf(7), 8);
	assert.equal(shift.lineOf(3), 4);
	assert.equal(shift.changedCharacterOf(3), undefined);
});

test('a change log gives the changes after a version only when it has each of them', () => {
	const log = new ChangeLog(10);
	const enter = [change(4, 3, 4, 3, '\n')];
	const typed = [change(0, 0, 0, 0, 'x')];
	log.record(11, enter);
	// VS Code sends a change of the dirty state as an event without changes, with the same version.
	log.record(11, []);
	log.record(12, typed);
	assert.equal(log.takeChangesAfter(9, 12), undefined, 'The log does not have version 10');
	assert.deepEqual(log.takeChangesAfter(10, 12), [enter, typed]);
	assert.deepEqual(log.takeChangesAfter(11, 12), [typed]);
	assert.deepEqual(log.takeChangesAfter(12, 12), []);
	assert.equal(log.takeChangesAfter(10, 12), undefined, 'A later base drops the older changes');

	// A new document of the file starts at version 1 again.
	log.record(1, []);
	log.record(2, typed);
	assert.deepEqual(log.takeChangesAfter(1, 2), [typed]);

	const short = new ChangeLog(2);
	short.record(1, []);
	short.record(2, []);
	short.record(3, typed);
	assert.equal(short.takeChangesAfter(0, 3), undefined, 'The log dropped its oldest event');
	assert.deepEqual(short.takeChangesAfter(1, 3), [[], typed]);
});

test('a moved artifact keeps the columns of a range only when no edit moved them', () => {
	const main = '/src/main.c';
	const listing = (sources: readonly RenderedArtifactLineSource[]): RenderedTextArtifact =>
		({ lines: sources.map((source) => ({ text: 'add', source })) }) as unknown as RenderedTextArtifact;
	const artifact = listing([
		{ file: main, line: 5, column: 8, endLine: 5, endColumn: 14 },
		{ file: main, line: 9, column: 2, endLine: 10, endColumn: 6 },
		{ file: '/src/other.h', line: 5, column: 8, endLine: 5, endColumn: 14 },
	]);
	const moved = (changes: readonly LineChange[]) => {
		const shift = new LineShift([4, 8, 9]);
		shift.apply(changes);
		return movedArtifact(artifact, shift, (file) => file === main).lines.map((line) => line.source);
	};

	// Enter at the end of line 5 moves no character of its range, and moves the later lines down.
	assert.deepEqual(moved([change(4, 20, 4, 20, '\n')]), [
		{ file: main, line: 5, column: 8, endLine: 5, endColumn: 14 },
		{ file: main, line: 10, column: 2, endLine: 11, endColumn: 6 },
		artifact.lines[2]?.source,
	]);
	// Typing right after the range keeps it. Typing before the range moves it, so it loses its columns.
	assert.deepEqual(moved([change(4, 14, 4, 14, 'x')])[0], {
		file: main,
		line: 5,
		column: 8,
		endLine: 5,
		endColumn: 14,
	});
	assert.deepEqual(moved([change(4, 2, 4, 2, 'x')])[0], { file: main, line: 5 });
	// Typing inside the end line of a range keeps its start column only.
	assert.deepEqual(moved([change(9, 3, 9, 3, 'x')])[1], { file: main, line: 9, column: 2 });
	// A deleted source line removes the source of its artifact line.
	assert.equal(moved([change(4, 0, 5, 0, '')])[0], null);
});
