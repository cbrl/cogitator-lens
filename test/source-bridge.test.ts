import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
	artifactScrollAnchor,
	ScrollSyncSuppression,
	sourceDensityLevel,
	sourceLineBandIndex,
	sourceScrollAnchor,
} from '../src/artifact-document/source-bridge.js';

test('source scroll anchoring selects the topmost visible mapped line', () => {
	const mapping = new Map<number, number[]>([
		[12, [30, 29]],
		[8, [21]],
		[10, [27, 25]],
	]);
	assert.deepEqual(sourceScrollAnchor(mapping, 9, 15), {
		sourceLine: 10,
		artifactLine: 25,
	});
	assert.equal(sourceScrollAnchor(mapping, 13, 20), undefined);
});

test('artifact scroll anchoring selects the first visible source location', () => {
	const lines = [
		{},
		{ source: { file: 'before.cpp', line: 1 } },
		{},
		{ source: { file: 'main.cpp', line: 7 } },
		{ source: { file: 'main.cpp', line: 8 } },
	];
	assert.deepEqual(artifactScrollAnchor(lines, 2, 4), {
		file: 'main.cpp',
		sourceLine: 6,
		artifactLine: 3,
	});
	assert.equal(artifactScrollAnchor(lines, 0, 0), undefined);
});

test('scroll synchronization suppresses every target event until scrolling settles', async () => {
	const sourceEditor = {};
	const targetEditor = {};
	const suppression = new ScrollSyncSuppression<object>(10, 20);

	suppression.begin(targetEditor);
	assert.equal(suppression.shouldSuppress(sourceEditor), false);
	assert.equal(suppression.shouldSuppress(targetEditor), true);
	await new Promise(resolve => setTimeout(resolve, 5));
	assert.equal(suppression.shouldSuppress(targetEditor), true);
	await new Promise(resolve => setTimeout(resolve, 20));
	assert.equal(suppression.shouldSuppress(targetEditor), false);

	suppression.dispose();
});

test('source density uses the full linear heat scale', () => {
	assert.equal(sourceDensityLevel(0, 10, 5), 0);
	assert.equal(sourceDensityLevel(1, 5, 5), 0);
	assert.equal(sourceDensityLevel(3, 5, 5), 2);
	assert.equal(sourceDensityLevel(5, 5, 5), 4);
	assert.equal(sourceDensityLevel(100, 5, 5), 4);
});

test('source density and source highlights select the same repeating color band', () => {
	assert.equal(sourceLineBandIndex(0, 6), 0);
	assert.equal(sourceLineBandIndex(5, 6), 5);
	assert.equal(sourceLineBandIndex(6, 6), 0);
	assert.equal(sourceLineBandIndex(14, 6), 2);
});
