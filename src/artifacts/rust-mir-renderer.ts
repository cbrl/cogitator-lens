import path from 'node:path';
import type {
	DisplayOptions,
	RawArtifact,
	RenderedArtifact,
	RenderedArtifactLine,
} from '../types/index.js';
import type { ArtifactRenderContext } from './artifact-definitions.js';
import { renderedArtifact } from './rendered-artifact.js';

const functionHeader = /^\s*fn\s+(.+?)\s*\(.*\).*\{\s*$/;
const basicBlock = /^\s*(bb\d+):\s*\{\s*$/;
const blockReference = /\bbb\d+\b/g;
const spanLocation = /\/\/.*?\bat\s+(.+?):(\d+):(\d+)(?::|\s|$)/;

export function renderRustMir(
	raw: RawArtifact,
	_options: DisplayOptions,
	_context: ArtifactRenderContext,
): RenderedArtifact {
	const textLines = splitLines(raw.text);
	const lines: RenderedArtifactLine[] = [];
	const functions: Array<{ name: string; line: number }> = [];
	const blocks: Array<{ name: string; line: number }> = [];
	let currentSource: RenderedArtifactLine['source'];

	for (const text of textLines) {
		const functionMatch = functionHeader.exec(text);
		if (functionMatch) {
			currentSource = undefined;
			functions.push({ name: functionMatch[1], line: lines.length });
		}
		const blockMatch = basicBlock.exec(text);
		if (blockMatch) {
			blocks.push({ name: blockMatch[1], line: lines.length });
		}
		const span = spanLocation.exec(text);
		if (span) {
			const filename = path.normalize(path.isAbsolute(span[1])
				? span[1]
				: path.resolve(raw.command.workingDirectory, span[1]));
			currentSource = {
				file: filename,
				line: Number.parseInt(span[2], 10),
				column: Math.max(0, Number.parseInt(span[3], 10) - 1),
			};
		}
		lines.push({ text, source: currentSource });
	}

	const definitions = new Map(blocks.map(block => [block.name, block.line]));
	const links = lines.flatMap((line, lineIndex) => {
		const ownDefinition = basicBlock.exec(line.text)?.[1];
		return [...line.text.matchAll(blockReference)].flatMap(match => {
			const name = match[0];
			const targetLine = definitions.get(name);
			return name !== ownDefinition && targetLine !== undefined
				? [{
					line: lineIndex,
					startCharacter: match.index,
					endCharacter: match.index + name.length,
					targetLine,
				}]
				: [];
		});
	});
	const folds = [
		...functions.flatMap(item => {
			const endLine = findClosingBrace(textLines, item.line);
			return endLine > item.line ? [{ startLine: item.line, endLine }] : [];
		}),
		...blocks.flatMap(item => {
			const endLine = findClosingBrace(textLines, item.line);
			return endLine > item.line ? [{ startLine: item.line, endLine }] : [];
		}),
	].sort((left, right) => left.startLine - right.startLine || left.endLine - right.endLine);

	return {
		...renderedArtifact(raw, lines, {
			functionCount: functions.length,
			basicBlockCount: blocks.length,
		}),
		links,
		folds,
		symbols: functions,
	};
}

function findClosingBrace(lines: readonly string[], startLine: number): number {
	let depth = 0;
	for (let line = startLine; line < lines.length; line++) {
		for (const character of lines[line]) {
			if (character === '{') {
				depth++;
			} else if (character === '}') {
				depth--;
				if (depth === 0) {
					return line;
				}
			}
		}
	}
	return startLine;
}

function splitLines(text: string): string[] {
	const lines = text.split(/\r\n|\n|\r/);
	if (lines.at(-1) === '') {
		lines.pop();
	}
	return lines;
}
