import { artifactDefinitions } from '../artifacts/core/artifact-definitions.js';
import type { ArtifactRenderContext } from '../artifacts/core/artifact-contracts.js';
import type { ArtifactImplementation } from '../toolchains/toolchain-contracts.js';
import type { ArtifactOptions, RawArtifact, RenderedArtifact } from '../types/index.js';

/**
 * Renders raw output with the renderer and listing syntax of the toolchain implementation.
 * Each one falls back to the default of the artifact kind.
 */
export async function renderArtifact(
	raw: RawArtifact,
	implementation: Pick<ArtifactImplementation, 'renderer' | 'listingSyntax'>,
	options: ArtifactOptions,
	context: ArtifactRenderContext,
): Promise<RenderedArtifact> {
	const definition = artifactDefinitions[raw.kind];
	const renderer = implementation.renderer ?? definition.renderer;
	if (!renderer) {
		throw new Error(`${context.backend.profile.displayName} declares no renderer for ${definition.label}.`);
	}
	const rendered = await renderer(raw, options.display, context);
	const listingSyntax = implementation.listingSyntax ?? definition.listingSyntax;
	return rendered.presentation === 'text' && listingSyntax ? { ...rendered, listingSyntax } : rendered;
}
