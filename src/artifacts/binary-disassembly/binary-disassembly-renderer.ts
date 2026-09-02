import type { DisplayOptions, RawArtifact, RenderedTextArtifact } from '../../types/index.js';
import { parsedLine, withLabelNavigation } from '../assembly/assembly-navigation.js';
import type { ArtifactRenderContext } from '../core/artifact-contracts.js';
import { renderedArtifact } from '../core/rendered-artifact.js';

export function renderBinaryDisassembly(
	raw: RawArtifact,
	options: DisplayOptions,
	context: ArtifactRenderContext,
): RenderedTextArtifact {
	const parsed = context.backend.parseBinaryDisassembly(raw.text, options);
	const lines = parsed.asm.map(parsedLine);
	return withLabelNavigation(
		renderedArtifact(raw, lines, {
			codeSizeBytes: parsed.asm.reduce((total, line) => total + (line.opcodes?.length ?? 0), 0),
			instructionCount: parsed.asm.filter((line) => line.opcodes?.length).length,
		}),
		parsed,
		(instruction) => context.backend.classifyAssemblyInstruction(instruction),
	);
}
