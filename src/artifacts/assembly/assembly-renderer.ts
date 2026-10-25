import type { DisplayOptions, RawArtifact, RenderedTextArtifact } from '../../types/index.js';
import type { ArtifactRenderContext } from '../core/artifact-contracts.js';
import { renderedArtifact } from '../core/rendered-artifact.js';
import { functionLabelTest, parsedLine, withLabelNavigation } from './assembly-navigation.js';

/** Renders compiler assembly and augments it with navigable labels and source locations. */
export function renderAssembly(
	raw: RawArtifact,
	options: DisplayOptions,
	context: ArtifactRenderContext,
): RenderedTextArtifact {
	const parsed = context.backend.parseAssembly(raw.text, options, {
		path: context.source.uri.fsPath,
		workingDirectory: raw.command.cwd,
	});
	const lines = parsed.asm.map(parsedLine);
	return withLabelNavigation(
		renderedArtifact(raw, lines, {
			labelCount: Object.keys(parsed.labelDefinitions ?? {}).length,
		}),
		parsed,
		(instruction) => context.backend.classifyAssemblyInstruction(instruction),
		functionLabelTest(raw.text),
	);
}
