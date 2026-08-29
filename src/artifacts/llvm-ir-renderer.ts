import path from 'path';
import type {
	DisplayOptions,
	RawArtifact,
	RenderedTextArtifact,
	RenderedArtifactLine,
} from '../types/index.js';
import type { ArtifactRenderContext } from './artifact-definitions.js';
import { LLVMIRDemangler } from '../vendor/lib/demangler/llvm.js';
import { LlvmIrParser } from '../vendor/lib/llvm-ir.js';
import { noopPropertyGetter } from '../vendor/compiler-props.js';
import { decodeLlvmString } from './llvm-names.js';
import { renderedArtifact } from './rendered-artifact.js';

const llvmIrParser = new LlvmIrParser(noopPropertyGetter, new LLVMIRDemangler());

export async function renderLlvmIr(
	raw: RawArtifact,
	_options: DisplayOptions,
	_context: ArtifactRenderContext,
): Promise<RenderedTextArtifact> {
	const parsed = await llvmIrParser.process(raw.text, {
		filterDebugInfo: false,
		filterIRMetadata: false,
		filterAttributes: false,
		filterComments: false,
		filterDeclarations: false,
		filterLibraryFunctions: false,
		demangle: false,
	});
	const lines: RenderedArtifactLine[] = parsed.asm.map(line => ({
		text: line.text,
		source: line.source?.file && line.source.line
			? {
				file: sourcePath(line.source.file, raw.command.workingDirectory),
				line: line.source.line,
				column: line.source.column === undefined
					? undefined
					: Math.max(0, line.source.column - 1),
			}
			: undefined,
	}));
	const symbols = lines.flatMap((line, lineIndex) => {
		const definition = /^\s*define\b.*?@(?:"((?:[^"\\]|\\.)+)"|([A-Za-z$._][\w$.-]*))\s*\(/
			.exec(line.text);
		return definition
			? [{ name: decodeLlvmString(definition[1] ?? definition[2]), line: lineIndex }]
			: [];
	});
	const folds = symbols.flatMap(symbol => {
		const endLine = findFunctionEnd(lines, symbol.line);
		return endLine > symbol.line ? [{ startLine: symbol.line, endLine }] : [];
	});

	return {
		...renderedArtifact(raw, lines, {
			functionCount: symbols.length,
		}),
		symbols,
		folds,
	};
}

function sourcePath(filename: string, workingDirectory: string): string {
	return path.normalize(path.isAbsolute(filename)
		? filename
		: path.resolve(workingDirectory, filename));
}


function findFunctionEnd(lines: readonly RenderedArtifactLine[], startLine: number): number {
	for (let line = startLine + 1; line < lines.length; line++) {
		if (/^\s*}\s*$/.test(lines[line].text)) {
			return line;
		}
	}
	return startLine;
}
