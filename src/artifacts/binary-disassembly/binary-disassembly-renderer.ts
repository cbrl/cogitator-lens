import type { DisplayOptions, RawArtifact, RenderedTextArtifact } from '../../types/index.js';
import { parsedLine, withLabelNavigation } from '../assembly/assembly-navigation.js';
import type { ArtifactRenderContext } from '../core/artifact-contracts.js';
import { renderedArtifact } from '../core/rendered-artifact.js';
import { binaryBranchLinks } from './branch-links.js';

/**
 * Renders normalized disassembler output with instruction and code-size metrics. The vendored
 * parser links a branch to the start of the function it names, or not at all when llvm-objdump
 * writes the address with `0x`, so the links come from the addresses instead.
 */
export function renderBinaryDisassembly(
	raw: RawArtifact,
	options: DisplayOptions,
	context: ArtifactRenderContext,
): RenderedTextArtifact {
	const parsed = context.backend.parseBinaryDisassembly(raw.text, options, {
		path: context.source.uri.fsPath,
		workingDirectory: raw.command.cwd,
	});
	const lines = parsed.asm.map(parsedLine);
	const classifyInstruction = (instruction: string) => context.backend.classifyAssemblyInstruction(instruction);
	const artifact = withLabelNavigation(
		renderedArtifact(raw, lines, {
			codeSizeBytes: parsed.asm.reduce((total, line) => total + (line.opcodes?.length ?? 0), 0),
			instructionCount: parsed.asm.filter((line) => line.opcodes?.length).length,
		}),
		parsed,
		classifyInstruction,
	);
	// The parser reports one-based line numbers.
	const functionLines = new Map(
		Object.entries(parsed.labelDefinitions ?? {}).map(([name, line]) => [name, line - 1] as const),
	);
	return { ...artifact, links: binaryBranchLinks(artifact.lines, functionLines, classifyInstruction) };
}
