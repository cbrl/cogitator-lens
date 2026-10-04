import path from 'node:path';
import type { DisplayOptions, RawArtifact, RenderedTextArtifact, RenderedArtifactLine } from '../../types/index.js';
import { splitLines } from '../../common.js';
import type { ArtifactRenderContext } from '../core/artifact-contracts.js';
import { renderedArtifact } from '../core/rendered-artifact.js';
import { resolveCompilerPath, sameLocalFile } from '../../local-file-identity.js';

interface AstNode {
	readonly kind: string;
	readonly depth: number;
	readonly line: number;
	readonly endLine: number;
	readonly name?: string;
}

interface AstSourcePosition {
	readonly file: string;
	readonly line: number;
	readonly column: number;
}

interface AstSourceSpan extends AstSourcePosition {
	readonly endLine: number;
	readonly endColumn: number;
}

export function renderClangAst(
	raw: RawArtifact,
	options: DisplayOptions,
	context: ArtifactRenderContext,
): RenderedTextArtifact {
	const sourceFile = path.normalize(context.source.uri.fsPath);
	const output: RenderedArtifactLine[] = [];
	const nodes: Array<Omit<AstNode, 'endLine'>> = [];
	const locations = new Map<number, AstSourcePosition>();
	let lastFile = sourceFile;
	let skipDepth: number | undefined;

	for (const rawLine of splitLines(raw.text)) {
		const parsed = parseClangNode(rawLine);
		if (!parsed) {
			if (skipDepth === undefined) {
				output.push({ text: normalizeClangAddresses(rawLine) });
			}
			continue;
		}
		if (skipDepth !== undefined && parsed.depth > skipDepth) {
			continue;
		}
		skipDepth = undefined;

		for (const depth of [...locations.keys()]) {
			if (depth > parsed.depth) {
				locations.delete(depth);
			}
		}
		const parentLocation = locations.get(parsed.depth - 1);
		const span = clangSourceSpan(rawLine, raw.command.workingDirectory, parentLocation, lastFile);
		const location: AstSourcePosition | undefined = span;
		if (location) {
			locations.set(parsed.depth, location);
			lastFile = location.file;
		}
		if (!options.showSystemDeclarations && location && isSystemDeclarationPath(location.file, sourceFile)) {
			skipDepth = parsed.depth;
			continue;
		}

		const line = output.length;
		const text = normalizeClangAddresses(rawLine);
		output.push({
			text,
			source: span
				? {
						file: span.file,
						line: span.line,
						column: span.column,
						endLine: span.endLine,
						endColumn: span.endColumn,
						mainSource: sameLocalFile(span.file, sourceFile),
					}
				: undefined,
		});
		nodes.push({
			kind: parsed.kind,
			depth: parsed.depth,
			line,
			name: clangDeclarationName(parsed.kind, text),
		});
	}

	const completeNodes = addIndentationEnds(nodes, output.length);
	const symbols = completeNodes.flatMap((node) =>
		node.name && isDeclarationNode(node.kind) ? [{ name: node.name, line: node.line }] : [],
	);

	const artifact = renderedArtifact(raw, output, {
		nodeCount: completeNodes.length,
		declarationCount: symbols.length,
	});
	const foldedLines = completeNodes.flatMap((node) =>
		node.endLine > node.line ? [{ startLine: node.line, endLine: node.endLine }] : [],
	);

	return { ...artifact, folds: foldedLines, symbols };
}

export function renderPythonAst(raw: RawArtifact, context: ArtifactRenderContext): RenderedTextArtifact {
	const textLines = splitLines(raw.text);
	const sourceLines = context.source.text.split(/\r\n|\n|\r/);
	const output: RenderedArtifactLine[] = textLines.map((text) => ({ text }));
	const nodes: AstNode[] = [];
	const nodeEnds = findPythonNodeEnds(textLines);

	for (let line = 0; line < textLines.length; line++) {
		const match = /^(\s*)([A-Za-z_]\w*)\($/.exec(textLines[line]);
		if (!match) {
			continue;
		}
		const indent = match[1].length;
		const endLine = nodeEnds.get(line) ?? line;
		const attributeIndent = indent + 2;
		let sourceLine: number | undefined;
		let sourceColumn = 0;
		let endSourceLine: number | undefined;
		let endSourceColumn: number | undefined;
		let name: string | undefined;
		for (let cursor = line + 1; cursor <= endLine; cursor++) {
			if (leadingSpaces(textLines[cursor]) !== attributeIndent) {
				continue;
			}
			const lineno = /^\s*lineno=(\d+)\b/.exec(textLines[cursor]);
			if (lineno && sourceLine === undefined) {
				sourceLine = Number.parseInt(lineno[1], 10);
			}
			const column = /^\s*col_offset=(\d+)\b/.exec(textLines[cursor]);
			if (column) {
				sourceColumn = Number.parseInt(column[1], 10);
			}
			const endLine = /^\s*end_lineno=(\d+)\b/.exec(textLines[cursor]);
			if (endLine) {
				endSourceLine = Number.parseInt(endLine[1], 10);
			}
			const endColumn = /^\s*end_col_offset=(\d+)\b/.exec(textLines[cursor]);
			if (endColumn) {
				endSourceColumn = Number.parseInt(endColumn[1], 10);
			}
			const named = /^\s*name=(['"])(.*?)\1,?$/.exec(textLines[cursor]);
			if (named && name === undefined) {
				name = named[2];
			}
		}
		if (sourceLine !== undefined) {
			const startColumn = pythonColumnToUtf16(sourceLines[sourceLine - 1], sourceColumn);
			const normalizedEndLine = endSourceLine ?? sourceLine;
			const normalizedEndColumn =
				endSourceColumn === undefined
					? startColumn + 1
					: pythonColumnToUtf16(sourceLines[normalizedEndLine - 1], endSourceColumn);
			output[line] = {
				text: output[line].text,
				source: {
					file: context.source.uri.fsPath,
					line: sourceLine,
					column: startColumn,
					endLine: normalizedEndLine,
					endColumn: normalizedEndColumn,
					mainSource: true,
				},
			};
		}
		nodes.push({
			kind: match[2],
			depth: indent / 2,
			line,
			endLine,
			name,
		});
	}

	const symbols = nodes.flatMap((node) =>
		node.name && pythonNamedDefinitionKinds.has(node.kind) ? [{ name: node.name, line: node.line }] : [],
	);
	return {
		...renderedArtifact(raw, output, {
			nodeCount: nodes.length,
			definitionCount: symbols.length,
		}),
		folds: nodes.flatMap((node) =>
			node.endLine > node.line ? [{ startLine: node.line, endLine: node.endLine }] : [],
		),
		symbols,
	};
}

function parseClangNode(text: string): { kind: string; depth: number } | undefined {
	const match = /^((?:\| |  )*)(?:(\|-|`-))?([A-Za-z][A-Za-z0-9]*)\b/.exec(text);
	return match
		? {
				kind: match[3],
				depth: match[1].length / 2 + (match[2] ? 1 : 0),
			}
		: undefined;
}

function normalizeClangAddresses(text: string): string {
	return text.replace(/\s+0x[0-9A-Fa-f]+\b/g, '');
}

function clangSourceSpan(
	text: string,
	workingDirectory: string,
	parent: AstSourcePosition | undefined,
	lastFile: string,
): AstSourceSpan | undefined {
	for (const match of text.matchAll(/<([^>]*)>/g)) {
		const tokens = match[1].split(',').map((value) => value.trim());
		const start = clangPosition(tokens[0], workingDirectory, parent, lastFile);
		if (!start) {
			continue;
		}
		const end = tokens.length > 1 ? clangPosition(tokens.at(-1)!, workingDirectory, start, start.file) : start;
		return sourceSpan(start, end);
	}
	const trailing = text.replace(/<[^>]*>/g, ' ');
	for (const token of trailing.split(/\s+/).map((value) => value.trim())) {
		const position = clangPosition(token, workingDirectory, parent, lastFile);
		if (position) {
			return sourceSpan(position, position);
		}
	}
	return parent ? sourceSpan(parent, parent) : undefined;
}

function clangPosition(
	token: string,
	workingDirectory: string,
	parent: AstSourcePosition | undefined,
	lastFile: string,
): AstSourcePosition | undefined {
	const explicit = /^(.*):(\d+):(\d+)$/.exec(token);
	if (explicit && explicit[1] !== 'line') {
		const filename = explicit[1];
		if (filename === '<invalid sloc>' || filename === '<built-in>') {
			return undefined;
		}
		return {
			file: resolveCompilerPath(filename, workingDirectory),
			line: Number.parseInt(explicit[2], 10),
			column: Math.max(0, Number.parseInt(explicit[3], 10) - 1),
		};
	}
	const line = /^line:(\d+):(\d+)$/.exec(token);
	if (line) {
		return {
			file: parent?.file ?? lastFile,
			line: Number.parseInt(line[1], 10),
			column: Math.max(0, Number.parseInt(line[2], 10) - 1),
		};
	}
	const column = /^col:(\d+)$/.exec(token);
	if (column && parent) {
		return {
			...parent,
			column: Math.max(0, Number.parseInt(column[1], 10) - 1),
		};
	}
	return undefined;
}

function sourceSpan(start: AstSourcePosition, end: AstSourcePosition | undefined): AstSourceSpan {
	const validEnd =
		end &&
		sameLocalFile(start.file, end.file) &&
		(end.line > start.line || (end.line === start.line && end.column >= start.column))
			? end
			: start;
	return {
		...start,
		endLine: validEnd.line,
		endColumn: validEnd.column + 1,
	};
}

function clangDeclarationName(kind: string, text: string): string | undefined {
	if (!isDeclarationNode(kind)) {
		return undefined;
	}
	const typedNames = [...text.matchAll(/\b([~A-Za-z_$][\w:$~<>.-]*)\s+'[^']*'/g)];
	if (typedNames.length > 0) {
		return typedNames.at(-1)![1];
	}
	const record = /\b(?:struct|class|union|enum)\s+([A-Za-z_$][\w:$.-]*)\b/.exec(text);
	if (record) {
		return record[1];
	}
	const namespace = /\bNamespaceDecl\b.*\b([A-Za-z_$][\w$]*)\s*$/.exec(text);
	return namespace?.[1];
}

function isDeclarationNode(kind: string): boolean {
	return kind.endsWith('Decl') && !['TranslationUnitDecl', 'AccessSpecDecl'].includes(kind);
}

function isSystemDeclarationPath(filename: string, sourceFile: string): boolean {
	if (sameLocalFile(filename, sourceFile)) {
		return false;
	}
	const normalized = filename.replace(/\\/g, '/').toLowerCase();
	return (
		normalized.startsWith('/usr/include/') ||
		normalized.includes('/lib/clang/') ||
		normalized.includes('/windows kits/') ||
		normalized.includes('/microsoft visual studio/') ||
		normalized.includes('.app/contents/developer/toolchains/') ||
		normalized.includes('/xcode.app/')
	);
}

function addIndentationEnds(nodes: readonly Omit<AstNode, 'endLine'>[], lineCount: number): AstNode[] {
	const endLines = new Array<number>(nodes.length).fill(Math.max(0, lineCount - 1));
	const stack: number[] = [];
	nodes.forEach((node, index) => {
		while (stack.length > 0 && nodes[stack.at(-1)!].depth >= node.depth) {
			const completed = stack.pop()!;
			endLines[completed] = Math.max(nodes[completed].line, node.line - 1);
		}
		stack.push(index);
	});
	return nodes.map((node, index) => ({
		...node,
		endLine: endLines[index],
	}));
}

function findPythonNodeEnds(lines: readonly string[]): ReadonlyMap<number, number> {
	const nodeStarts = new Set(
		lines.flatMap((line, lineIndex) => (/^(\s*)([A-Za-z_]\w*)\($/.test(line) ? [lineIndex] : [])),
	);
	const ends = new Map<number, number>();
	const stack: Array<{ line: number; node: boolean }> = [];
	let quote: string | undefined;
	let escaped = false;
	for (let line = 0; line < lines.length; line++) {
		for (const character of lines[line]) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (character === '\\' && quote) {
				escaped = true;
				continue;
			}
			if (quote) {
				if (character === quote) {
					quote = undefined;
				}
				continue;
			}
			if (character === '"' || character === "'") {
				quote = character;
			} else if (character === '(') {
				stack.push({ line, node: nodeStarts.has(line) && lines[line].trimEnd().endsWith('(') });
			} else if (character === ')') {
				const opening = stack.pop();
				if (opening?.node) {
					ends.set(opening.line, line);
				}
			}
		}
	}
	return ends;
}

function leadingSpaces(value: string): number {
	return /^\s*/.exec(value)?.[0].length ?? 0;
}

function pythonColumnToUtf16(line: string | undefined, utf8Column: number): number {
	if (line === undefined || utf8Column <= 0) {
		return Math.max(0, utf8Column);
	}
	let bytes = 0;
	let utf16 = 0;
	for (const character of line) {
		const characterBytes = Buffer.byteLength(character, 'utf8');
		if (bytes + characterBytes > utf8Column) {
			break;
		}
		bytes += characterBytes;
		utf16 += character.length;
	}
	return bytes === utf8Column ? utf16 : utf8Column;
}

const pythonNamedDefinitionKinds = new Set(['FunctionDef', 'AsyncFunctionDef', 'ClassDef']);
