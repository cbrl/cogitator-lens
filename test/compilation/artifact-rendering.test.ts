import assert from 'node:assert/strict';
import test from 'node:test';
import { renderArtifact } from '../../src/compilation/artifact-rendering.js';
import { defaultArtifactOptions, type RenderedArtifactLine } from '../../src/types/index.js';
import type { ArtifactRenderer } from '../../src/artifacts/core/artifact-contracts.js';
import { rawArtifact, renderContext, textArtifact } from '../support/artifacts.js';

function renderer(marker: string): ArtifactRenderer {
	return (raw) => textArtifact(raw.kind, [{ text: marker } as RenderedArtifactLine]);
}

test('artifact rendering prefers the selected output, then the backend, then the kind default', async () => {
	const raw = rawArtifact('preprocessed-source', 'int value;');
	const context = renderContext('gcc');
	const backendRenderer = renderer('backend');
	const backend = {
		...context.backend,
		getArtifactRenderer: () => backendRenderer,
	} as unknown as typeof context.backend;
	const overriddenContext = { ...context, backend };

	const selected = await renderArtifact(raw, defaultArtifactOptions, overriddenContext, renderer('output'));
	assert.equal(selected.presentation === 'text' ? selected.lines[0].text : undefined, 'output');
	const toolchain = await renderArtifact(raw, defaultArtifactOptions, overriddenContext);
	assert.equal(toolchain.presentation === 'text' ? toolchain.lines[0].text : undefined, 'backend');
	const fallback = await renderArtifact(raw, defaultArtifactOptions, context);
	assert.equal(fallback.presentation, 'text');
});

test('artifact rendering prefers a cell listing syntax over the kind default', async () => {
	const raw = rawArtifact('assembly', 'nop');
	const rendered = await renderArtifact(
		raw,
		defaultArtifactOptions,
		renderContext('gcc'),
		renderer('nop'),
		'python-bytecode',
	);
	assert.equal(rendered.presentation === 'text' ? rendered.listingSyntax : undefined, 'python-bytecode');
});
