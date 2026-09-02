import type { DisplayOptions, RawArtifact, RenderedTextArtifact, RenderedArtifactLine } from '../../types/index.js';
import type { ArtifactRenderContext } from '../core/artifact-contracts.js';
import { renderedArtifact } from '../core/rendered-artifact.js';
import { pythonBytecodeInstruction } from '../../artifact-document/artifact-listing-syntax.js';

const sourceLinePrefix = /^\s{0,3}(\d+)\s+/;

export function renderPythonBytecode(
	raw: RawArtifact,
	_options: DisplayOptions,
	context: ArtifactRenderContext,
): RenderedTextArtifact {
	let currentSourceLine: number | undefined;
	const mappedSourceLines = new Set<number>();
	let instructionCount = 0;
	let codeObjectCount = 1;

	const lines: RenderedArtifactLine[] = splitLines(raw.text).map((text) => {
		if (/^Disassembly of\b/.test(text)) {
			currentSourceLine = undefined;
			codeObjectCount++;
		}

		const sourceMatch = sourceLinePrefix.exec(text);
		if (sourceMatch) {
			const candidate = Number.parseInt(sourceMatch[1], 10);
			currentSourceLine = candidate > 0 ? candidate : undefined;
		}

		const isInstruction = pythonBytecodeInstruction.test(text);
		if (isInstruction) {
			instructionCount++;
		}
		if (!isInstruction || currentSourceLine === undefined) {
			return { text };
		}

		mappedSourceLines.add(currentSourceLine);
		return {
			text,
			source: {
				file: context.source.uri.fsPath,
				line: currentSourceLine,
				column: 0,
				mainSource: true,
			},
		};
	});

	return renderedArtifact(raw, lines, {
		instructionCount,
		codeObjectCount: instructionCount === 0 ? 0 : codeObjectCount,
		sourceLineCount: mappedSourceLines.size,
	});
}

function splitLines(text: string): string[] {
	const lines = text.split(/\r\n|\n|\r/);
	if (lines.at(-1) === '') {
		lines.pop();
	}
	return lines;
}
