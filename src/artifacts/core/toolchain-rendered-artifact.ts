import type { DisplayOptions, RawArtifact, RenderedTextArtifact } from '../../types/index.js';
import type { ArtifactRenderContext } from './artifact-contracts.js';

export function renderToolchainArtifact(
	raw: RawArtifact,
	options: DisplayOptions,
	context: ArtifactRenderContext,
): RenderedTextArtifact {
	const artifact = context.backend.renderArtifact(raw, options, context);
	if (artifact.presentation !== 'text') {
		throw new Error(`Expected a text renderer for ${raw.kind}.`);
	}
	return artifact;
}
