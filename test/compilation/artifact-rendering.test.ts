import assert from 'node:assert/strict';
import test from 'node:test';
import { renderArtifact } from '../../src/compilation/artifact-rendering.js';
import { defaultArtifactOptions, type RenderedArtifactLine } from '../../src/types/index.js';
import type { ArtifactRenderer } from '../../src/artifacts/core/artifact-contracts.js';
import { rawArtifact, renderContext, textArtifact } from '../support/artifacts.js';

function renderer(marker: string): ArtifactRenderer {
	return (raw) => textArtifact(raw.kind, [{ text: marker } as RenderedArtifactLine]);
}

function firstLine(rendered: Awaited<ReturnType<typeof renderArtifact>>): string | undefined {
	return rendered.presentation === 'text' ? rendered.lines[0]?.text : undefined;
}

test('artifact rendering prefers the implementation renderer over the kind default', async () => {
	const raw = rawArtifact('preprocessed-source', 'int value;');
	const context = renderContext('gcc');

	const overridden = await renderArtifact(
		raw,
		{ renderer: renderer('implementation') },
		defaultArtifactOptions,
		context,
	);
	assert.equal(firstLine(overridden), 'implementation');
	const fallback = await renderArtifact(raw, {}, defaultArtifactOptions, context);
	assert.equal(firstLine(fallback), 'int value;');
});

test('artifact rendering requires a renderer when the kind has no default', async () => {
	await assert.rejects(renderArtifact(rawArtifact('ast', ''), {}, defaultArtifactOptions, renderContext('gcc')));
});

test('artifact rendering prefers an implementation listing syntax over the kind default', async () => {
	const raw = rawArtifact('assembly', 'nop');
	const context = renderContext('gcc');
	const overridden = await renderArtifact(
		raw,
		{ renderer: renderer('nop'), listingSyntax: 'python-bytecode' },
		defaultArtifactOptions,
		context,
	);
	assert.equal(overridden.presentation === 'text' ? overridden.listingSyntax : undefined, 'python-bytecode');
	const fallback = await renderArtifact(raw, { renderer: renderer('nop') }, defaultArtifactOptions, context);
	assert.equal(fallback.presentation === 'text' ? fallback.listingSyntax : undefined, 'native-assembly');
});
