import { artifactDefinitions } from '../artifacts/core/artifact-definitions.js';
import type {
	ArtifactListingSyntax,
	ArtifactRenderContext,
	ArtifactRenderer,
} from '../artifacts/core/artifact-contracts.js';
import type { ArtifactOptions, RawArtifact, RenderedArtifact } from '../types/index.js';

/**
 * Renders an artifact with output-specific overrides taking precedence over toolchain and kind defaults.
 * A selected output's listing syntax likewise overrides the artifact-kind syntax.
 */
export async function renderArtifact(
	raw: RawArtifact,
	options: ArtifactOptions,
	context: ArtifactRenderContext,
	outputRenderer?: ArtifactRenderer,
	listingSyntax?: ArtifactListingSyntax,
): Promise<RenderedArtifact> {
	const renderer =
		outputRenderer ?? context.backend.getArtifactRenderer(raw.kind) ?? artifactDefinitions[raw.kind].renderer;
	const rendered = await renderer(raw, options.display, context);
	if (rendered.presentation !== 'text') {
		return rendered;
	}
	const resolvedSyntax = listingSyntax ?? artifactDefinitions[raw.kind].listingSyntax;
	return resolvedSyntax ? { ...rendered, listingSyntax: resolvedSyntax } : rendered;
}
