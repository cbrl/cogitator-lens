import assert from 'node:assert/strict';
import test from 'node:test';
import { artifactDefinitions } from '../../src/artifacts/core/artifact-definitions.js';
import { renderLlvmIr } from '../../src/artifacts/llvm-ir/llvm-ir-renderer.js';
import {
	defaultListingLineLimit,
	getListingLineLimit,
	listingPropertyGetter,
	parseListingLineLimit,
	perListingLineLimit,
	setListingLineLimit,
} from '../../src/compilation/listing-limit.js';
import { defaultArtifactOptions } from '../../src/types/index.js';
import { rawArtifact, renderContext } from '../support/artifacts.js';

const projectRoot = process.platform === 'win32' ? 'C:/project' : '/project';

/** Runs a test with a listing line limit, and restores the default after it. */
async function withLimit(limit: number, action: () => Promise<void> | void): Promise<void> {
	setListingLineLimit(limit);
	try {
		await action();
	} finally {
		setListingLineLimit(defaultListingLineLimit);
	}
}

test('a listing line limit is a whole number within the limits', () => {
	assert.equal(parseListingLineLimit(5000), 5000);
	assert.equal(parseListingLineLimit(' 20000 '), 20000);
	assert.equal(parseListingLineLimit(100), 100);
	assert.equal(parseListingLineLimit(1_000_000), 1_000_000);
	for (const invalid of [99, 1_000_001, 150.5, '12k', '', undefined, null, Number.NaN]) {
		assert.equal(parseListingLineLimit(invalid), undefined, String(invalid));
	}
	setListingLineLimit(-1);
	assert.equal(getListingLineLimit(), defaultListingLineLimit, 'An invalid setting uses the default');
});

test('the parsers get the listing line limit and the defaults of other properties', async () => {
	await withLimit(250, () => {
		assert.equal(listingPropertyGetter('maxLinesOfAsm', 5000), 250);
		assert.equal(listingPropertyGetter('binaryHideFuncRe'), undefined);
		assert.equal(listingPropertyGetter('other', 'value'), 'value');
	});
});

test('a value per listing line limit is made again only when the limit changes', async () => {
	let made = 0;
	const parser = perListingLineLimit(() => ++made);
	assert.equal(parser(), 1);
	assert.equal(parser(), 1);
	await withLimit(300, () => {
		assert.equal(parser(), 2);
		assert.equal(parser(), 2);
	});
	assert.equal(parser(), 3);
});

test('LLVM IR stops at the listing line limit, and a new limit applies to the next render', async () => {
	const body = Array.from({ length: 300 }, (_, index) => `  %${index + 1} = add i32 %0, ${index}`);
	const raw = rawArtifact('llvm-ir', ['define i32 @main(i32 %0) {', ...body, '  ret i32 %0', '}'].join('\n'));
	const context = renderContext('clang');
	await withLimit(100, async () => {
		const short = await renderLlvmIr(raw, defaultArtifactOptions.display, context);
		assert.equal(short.truncated, true);
		assert.equal(short.lines.length, 101);
		assert.equal(short.lines.at(-1)?.text, '[truncated; too many lines]');
	});
	await withLimit(1000, async () => {
		const full = await renderLlvmIr(raw, defaultArtifactOptions.display, context);
		assert.equal(full.truncated, false);
		assert.equal(full.lines.at(-1)?.text, '}');
	});
});

test('binary disassembly stops at the listing line limit of the backend parser', async () => {
	const instructions = Array.from(
		{ length: 300 },
		(_, index) => `  ${index.toString(16)}: 90                    nop`,
	);
	const text = ['0000000000000000 <main>:', `${projectRoot}/source.cpp:7`, ...instructions].join('\n');
	// One backend renders both, so the second render shows that the backend made a new parser.
	const context = renderContext('gcc', { file: `${projectRoot}/source.cpp` });
	const renderWith = () =>
		artifactDefinitions['binary-disassembly'].renderer(
			rawArtifact('binary-disassembly', text, {
				command: { executable: process.execPath, args: [], environmentVariableNames: [], cwd: process.cwd() },
			}),
			defaultArtifactOptions.display,
			context,
		);
	await withLimit(100, async () => {
		const short = await renderWith();
		assert.equal(short.truncated, true);
		assert.ok(short.lines.some((line) => line.text === '[truncated; too many lines]'));
	});
	await withLimit(1000, async () => {
		const full = await renderWith();
		assert.equal(full.truncated, false);
		assert.equal(full.presentation === 'text' && full.lines.filter((line) => line.opcodes?.length).length, 300);
	});
});
