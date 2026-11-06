import type { ArtifactFold, ArtifactLink, ArtifactSymbol, RenderedArtifactLine } from '../../types/index.js';

/** A local name: `%5`, `%x.addr`, or a quoted name such as `%"a b"`. */
const localToken = /%(?:[-\w.$]+|"(?:[^"\\]|\\.)*")/g;
/** A global name: `@main`, `@.str`, or a quoted name. */
const globalToken = /@(?:[-\w.$]+|"(?:[^"\\]|\\.)*")/g;
/** A basic block label at the start of a line: `5:`, `entry:`, or a quoted label. */
const labelDefinition = /^([-\w.$]+|"(?:[^"\\]|\\.)*"):/;
/** A local value definition: `%5 = ...`. */
const valueDefinition = /^\s*(%(?:[-\w.$]+|"(?:[^"\\]|\\.)*"))\s*=/;
/** A global variable or alias definition: `@x = ...`. */
const globalDefinition = /^(@(?:[-\w.$]+|"(?:[^"\\]|\\.)*"))\s*=/;
/** The global name of a function definition. */
const functionName = /^\s*define\b.*?(@(?:[-\w.$]+|"(?:[^"\\]|\\.)*"))\s*\(/;

/**
 * Links each use of a label, a local value, or a global to the line that defines it. Labels and
 * values are local to their function. A branch gets an edge kind, so the editor draws its arrow.
 */
export function llvmIrLinks(
	lines: readonly RenderedArtifactLine[],
	symbols: readonly ArtifactSymbol[],
	folds: readonly ArtifactFold[],
): ArtifactLink[] {
	const globals = new Map<string, number>();
	lines.forEach((line, index) => {
		const name = functionName.exec(line.text)?.[1] ?? globalDefinition.exec(line.text)?.[1];
		if (name && !globals.has(name)) {
			globals.set(name, index);
		}
	});
	const links: ArtifactLink[] = [];
	const functionEnds = new Map(folds.map((fold) => [fold.startLine, fold.endLine]));
	for (const symbol of symbols) {
		const endLine = functionEnds.get(symbol.line);
		if (endLine === undefined) {
			continue;
		}
		links.push(...functionLinks(lines, symbol.line, endLine));
	}
	lines.forEach((line, index) => {
		for (const match of tokens(line.text, globalToken)) {
			const targetLine = globals.get(match.text);
			if (targetLine !== undefined && targetLine !== index) {
				links.push({ line: index, startCharacter: match.start, endCharacter: match.end, targetLine });
			}
		}
	});
	return links.sort((left, right) => left.line - right.line || left.startCharacter - right.startCharacter);
}

/** The links of the local names in one function. The arguments of the function are on its first line. */
function functionLinks(lines: readonly RenderedArtifactLine[], startLine: number, endLine: number): ArtifactLink[] {
	const definitions = new Map<string, number>();
	const header = lines[startLine].text;
	const argumentsStart = header.indexOf('(', header.search(/@/));
	for (const match of tokens(header.slice(Math.max(argumentsStart, 0)), localToken)) {
		definitions.set(match.text, startLine);
	}
	for (let index = startLine + 1; index <= endLine; index++) {
		const text = lines[index].text;
		const label = labelDefinition.exec(text)?.[1];
		const value = valueDefinition.exec(text)?.[1];
		if (label !== undefined) {
			definitions.set(`%${label}`, index);
		} else if (value !== undefined) {
			definitions.set(value, index);
		}
	}
	const links: ArtifactLink[] = [];
	for (let index = startLine + 1; index <= endLine; index++) {
		const text = lines[index].text;
		const branch = /^\s*br\s+(i1\s|label\s)/.exec(text)?.[1];
		let labelIndex = 0;
		for (const match of tokens(text, localToken)) {
			const targetLine = definitions.get(match.text);
			if (targetLine === undefined || targetLine === index) {
				continue;
			}
			const isLabel = text.slice(Math.max(0, match.start - 6), match.start) === 'label ';
			const edgeKind =
				isLabel && branch
					? branch === 'label '
						? 'unconditional'
						: labelIndex === 0
							? 'true'
							: undefined
					: undefined;
			if (isLabel) {
				labelIndex++;
			}
			links.push({
				line: index,
				startCharacter: match.start,
				endCharacter: match.end,
				targetLine,
				...(edgeKind ? { edgeKind } : {}),
			});
		}
	}
	return links;
}

function tokens(text: string, pattern: RegExp): Array<{ text: string; start: number; end: number }> {
	// Text after a semicolon is a comment, such as `; preds = %3`. Strings can hold one, so they are skipped.
	const comment = commentStart(text);
	return [...text.matchAll(pattern)]
		.filter((match) => match.index < comment)
		.map((match) => ({ text: match[0], start: match.index, end: match.index + match[0].length }));
}

function commentStart(text: string): number {
	let quoted = false;
	for (let index = 0; index < text.length; index++) {
		const character = text[index];
		if (character === '"' && text[index - 1] !== '\\') {
			quoted = !quoted;
		} else if (character === ';' && !quoted) {
			return index;
		}
	}
	return text.length;
}
