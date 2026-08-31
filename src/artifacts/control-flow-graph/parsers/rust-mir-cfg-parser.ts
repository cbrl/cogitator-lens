import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type {
	ControlFlowEdge,
	ControlFlowEdgeKind,
	ControlFlowGraph,
	ControlFlowNode,
	ControlFlowSourceLocation,
	ControlFlowTerminal,
} from '../../../types/index.js';
import { compilerSourceUri, GraphIdAllocator, splitLines } from '../cfg-parser-support.js';
import type { GraphParseResult } from '../control-flow-graph-model.js';

/**
 * Parses the stable, human-readable MIR dump emitted by rustc into function
 * level control-flow graphs.  This module deliberately does not invoke rustc,
 * read files, or validate the result for a webview; those concerns belong to
 * the producer and the shared graph validator respectively.
 */

interface FunctionBuilder {
	readonly id: string;
	readonly label: string;
	readonly startLine: number;
	readonly bodyDepth: number;
	readonly blocks: BlockBuilder[];
	readonly errors: string[];
}

interface BlockBuilder {
	readonly id: string;
	readonly headerLine: number;
	readonly openDepth: number;
	readonly lines: string[];
	readonly lineIndexes: number[];
	source?: ControlFlowSourceLocation;
	closed: boolean;
	closeLine?: number;
}

interface Terminator {
	readonly edges: readonly Successor[];
	readonly terminal?: ControlFlowTerminal;
}

interface Successor {
	readonly target: string;
	readonly kind: ControlFlowEdgeKind;
	readonly label?: string;
}

interface SourceSpan {
	readonly filename: string;
	readonly line: number;
	readonly column: number;
	readonly endLine?: number;
	readonly endColumn?: number;
}

/**
 * Parse all Rust MIR functions in `text`.
 *
 * A malformed function is omitted independently.  This is important for MIR
 * dumps produced while rustc is recovering from an error: later functions can
 * still provide useful graphs and diagnostics identify only the bad function.
 */
export function parseRustMirControlFlowGraphs(text: string, workingDirectory: string): GraphParseResult {
	const lines = splitLines(text);
	const graphs: ControlFlowGraph[] = [];
	const diagnostics: string[] = [];
	let current: FunctionBuilder | undefined;
	let currentBlock: BlockBuilder | undefined;
	let braceDepth = 0;
	const graphIds = new GraphIdAllocator('rust');
	let sawFunction = false;

	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const line = lines[lineIndex];
		// Recover at a later function header when an earlier body is
		// missing its closing brace. MIR bodies do not contain nested `fn`
		// declarations, so this boundary is safe and keeps later graphs useful.
		if (current && parseFunctionLabel(line) !== undefined) {
			current.errors.push('function body is not closed');
			finishFunction(current, graphs, diagnostics);
			current = undefined;
			currentBlock = undefined;
			braceDepth = 0;
		}
		if (!current) {
			const functionLabel = parseFunctionLabel(line);
			if (functionLabel === undefined) {
				continue;
			}
			sawFunction = true;
			// The ID is claimed at the header so a later function keeps its
			// identity even when an earlier same-named body is omitted.
			const id = graphIds.allocate(functionLabel);
			const delta = braceDelta(line);
			if (delta <= 0) {
				diagnostics.push(`Omitted Rust MIR function ${JSON.stringify(functionLabel)}: missing function body.`);
				continue;
			}
			current = {
				id,
				label: functionLabel,
				startLine: lineIndex,
				bodyDepth: delta,
				blocks: [],
				errors: [],
			};
			braceDepth = delta;
			currentBlock = undefined;
			continue;
		}

		const blockMatch = /^\s*(bb\d+)(?:\s*\([^)]*\))?\s*:\s*\{/.exec(line);
		if (blockMatch) {
			if (currentBlock && !currentBlock.closed) {
				current.errors.push(
					`basic block ${JSON.stringify(currentBlock.id)} is not closed before ${JSON.stringify(blockMatch[1])}`,
				);
			}
			const block: BlockBuilder = {
				id: blockMatch[1],
				headerLine: lineIndex,
				openDepth: braceDepth + braceDelta(line),
				lines: [],
				lineIndexes: [],
				closed: false,
			};
			if (current.blocks.some((candidate) => candidate.id === block.id)) {
				current.errors.push(`duplicate basic block ${JSON.stringify(block.id)}`);
			}
			current.blocks.push(block);
			currentBlock = block;
		}

		if (currentBlock && !currentBlock.closed) {
			appendBlockLine(currentBlock, lineIndex, line, workingDirectory);
		}

		const nextDepth = braceDepth + braceDelta(line);
		if (currentBlock && !currentBlock.closed && nextDepth < currentBlock.openDepth) {
			currentBlock.closed = true;
			currentBlock.closeLine = lineIndex;
		}
		braceDepth = nextDepth;

		if (braceDepth < current.bodyDepth) {
			finishFunction(current, graphs, diagnostics);
			current = undefined;
			currentBlock = undefined;
			braceDepth = 0;
		}
	}

	if (current) {
		current.errors.push('function body is not closed');
		finishFunction(current, graphs, diagnostics);
	}
	if (!sawFunction && text.trim()) {
		diagnostics.push('Rust MIR output contains no function definitions.');
	}

	return { graphs, diagnostics };
}

function finishFunction(functionBuilder: FunctionBuilder, graphs: ControlFlowGraph[], diagnostics: string[]): void {
	if (functionBuilder.errors.length > 0) {
		diagnostics.push(
			`Omitted Rust MIR function ${JSON.stringify(functionBuilder.label)}: ` +
				`${functionBuilder.errors.join('; ')}.`,
		);
		return;
	}
	if (functionBuilder.blocks.length === 0) {
		diagnostics.push(`Omitted Rust MIR function ${JSON.stringify(functionBuilder.label)}: no basic blocks found.`);
		return;
	}

	const parsedBlocks = functionBuilder.blocks.map((block) => ({
		block,
		terminator: parseBlockTerminator(block),
	}));
	const parseErrors = parsedBlocks.flatMap(({ block, terminator }) =>
		terminator.error ? [`basic block ${JSON.stringify(block.id)}: ${terminator.error}`] : [],
	);
	if (parseErrors.length > 0) {
		diagnostics.push(
			`Omitted Rust MIR function ${JSON.stringify(functionBuilder.label)}: ` + `${parseErrors.join('; ')}.`,
		);
		return;
	}

	const nodeIds = new Set(functionBuilder.blocks.map((block) => block.id));
	const edges: ControlFlowEdge[] = [];
	const edgeKeys = new Set<string>();
	for (const { block, terminator } of parsedBlocks) {
		for (const successor of terminator.successors) {
			if (!nodeIds.has(successor.target)) {
				diagnostics.push(
					`Omitted Rust MIR function ${JSON.stringify(functionBuilder.label)}: ` +
						`basic block ${JSON.stringify(block.id)} targets unknown block ` +
						`${JSON.stringify(successor.target)}.`,
				);
				return;
			}
			const key = `${block.id}\0${successor.target}\0${successor.kind}\0${successor.label ?? ''}`;
			if (edgeKeys.has(key)) {
				continue;
			}
			edgeKeys.add(key);
			edges.push({
				from: block.id,
				to: successor.target,
				kind: successor.kind,
				...(successor.label === undefined ? {} : { label: successor.label }),
			});
		}
	}

	const nodes: ControlFlowNode[] = parsedBlocks.map(({ block, terminator }) => ({
		id: block.id,
		label: blockLabel(block),
		referencedArtifactLines: [...block.lineIndexes],
		...(block.source ? { source: block.source } : {}),
		...(terminator.terminal ? { terminal: terminator.terminal } : {}),
	}));
	graphs.push({
		id: functionBuilder.id,
		label: functionBuilder.label,
		nodes,
		edges,
		...(nodes[0] ? { entryNodeId: nodes[0].id } : {}),
	});
}

function appendBlockLine(block: BlockBuilder, lineIndex: number, line: string, workingDirectory: string): void {
	block.lines.push(line);
	block.lineIndexes.push(lineIndex);
	if (!block.source) {
		const span = parseSourceSpan(line);
		if (span) {
			block.source = sourceLocation(span, workingDirectory);
		}
	}
}

function blockLabel(block: BlockBuilder): string {
	const label = block.lines
		.map((line) => line.trimEnd())
		.join('\n')
		.trim();
	return label || block.id;
}

interface ParsedTerminator {
	readonly successors: readonly Successor[];
	readonly terminal?: ControlFlowTerminal;
	readonly error?: string;
}

function parseBlockTerminator(block: BlockBuilder): ParsedTerminator {
	const meaningful = block.lines
		.map((line) => stripComment(line).trim())
		.filter((line) => line && line !== '}' && !/^bb\d+(?:\s*\([^)]*\))?\s*:\s*\{?$/.test(line));
	if (meaningful.length === 0) {
		return { successors: [], error: 'missing terminator' };
	}

	let start = meaningful.length - 1;
	const last = meaningful[start];
	if (isTerminatorContinuation(last)) {
		while (start > 0 && !isTerminatorStart(meaningful[start])) {
			start--;
		}
	}
	const line = meaningful.slice(start).join(' ');
	const terminator = parseTerminatorLine(line);
	if (terminator) {
		return terminator;
	}
	// MIR has one terminator per basic block. Once the final non-empty line
	// is not recognized, continuing upward would incorrectly treat an earlier
	// statement as the block's control flow.
	return { successors: [], error: `unrecognized terminator ${JSON.stringify(line)}` };
}

function isTerminatorStart(line: string): boolean {
	return /^(?:goto\b|switchInt\b|return\b|resume\b|abort\b|unreachable\b|(?:_\S+\s*=\s*)?[A-Za-z_][\w:]*[\s\S]*->)/u.test(
		line,
	);
}

function isTerminatorContinuation(line: string): boolean {
	return (
		line.startsWith('[') ||
		line.startsWith(']') ||
		/^(?:success|return|unwind|drop|resume|real|imaginary)\s*:/iu.test(line)
	);
}

function parseTerminatorLine(line: string): ParsedTerminator | undefined {
	if (/^goto\s*->\s*(bb\d+)\s*;?\s*$/.test(line)) {
		const target = /^goto\s*->\s*(bb\d+)/.exec(line)![1];
		return { successors: [{ target, kind: 'unconditional' }] };
	}
	if (/^switchInt\b/.test(line)) {
		const successors = parseBracketSuccessors(line, 'switch');
		return successors.length > 0
			? { successors }
			: { successors: [], error: 'switchInt has no basic-block successors' };
	}
	if (/^return\s*;?\s*$/.test(line)) {
		return { successors: [], terminal: 'return' };
	}
	if (/^resume\s*;?\s*$/.test(line)) {
		return { successors: [], terminal: 'resume' };
	}
	if (/^abort\s*;?\s*$/.test(line)) {
		return { successors: [], terminal: 'throw' };
	}
	if (/^unreachable\s*;?\s*$/.test(line)) {
		return { successors: [], terminal: 'unreachable' };
	}

	// Calls, drops, asserts, yields, and false-edge terminators all encode
	// successors in the same bracketed form. Matching the terminator family
	// only controls edge kinds; the parser remains tolerant of MIR's changing
	// call syntax and of additional call-like terminators.
	const arrow = line.lastIndexOf('->');
	if (arrow >= 0) {
		const unwindOnly = /^unwind\s*(?::\s*)?(continue|unreachable|cleanup|terminate(?:\([^)]*\))?)\s*;?$/iu.exec(
			line.slice(arrow + 2).trim(),
		);
		if (unwindOnly) {
			return {
				successors: [],
				terminal: unwindOnly[1].toLowerCase() === 'unreachable' ? 'unreachable' : 'throw',
			};
		}
	}
	if (arrow >= 0 && line.includes('[', arrow)) {
		const family = /^\s*(?:_\S+\s*=\s*)?([A-Za-z_][\w]*)/.exec(line)?.[1] ?? '';
		const successors = parseBracketSuccessors(line, family === 'switchInt' ? 'switch' : family);
		const hasSuccessorSyntax = /\[.*\]/.test(line);
		if (successors.length > 0) {
			return { successors };
		}
		if (
			hasSuccessorSyntax &&
			/\bunwind\s*(?::\s*)?(?:continue|unreachable|cleanup|terminate(?:\([^)]*\))?)\b/.test(line)
		) {
			return { successors: [] };
		}
		return { successors: [], error: 'terminator has no recognizable basic-block successor' };
	}
	return undefined;
}

function parseBracketSuccessors(line: string, family: string): Successor[] {
	const arrow = line.lastIndexOf('->');
	const start = line.indexOf('[', arrow >= 0 ? arrow : 0);
	if (start < 0) {
		return [];
	}
	const end = findClosingBracket(line, start);
	const body = line.slice(start + 1, end < 0 ? line.length : end);
	const successors: Successor[] = [];
	const pairPattern = /([^,\]]+?)\s*:\s*(bb\d+)/g;
	for (const match of body.matchAll(pairPattern)) {
		const label = match[1].trim();
		const target = match[2];
		const edgeLabel = successorLabel(family, label);
		const successor: Successor = {
			target,
			kind: successorKind(family, label),
			...(edgeLabel === undefined ? {} : { label: edgeLabel }),
		};
		successors.push(successor);
	}
	// Some rustc versions omit the colon for cleanup continuations. They are
	// not graph edges when they say `continue`/`unreachable`, but a bare `bbN`
	// still denotes a real unwind successor.
	for (const match of body.matchAll(/\bunwind\s+(bb\d+)\b/g)) {
		const target = match[1];
		if (!successors.some((successor) => successor.target === target && successor.kind === 'exception')) {
			successors.push({ target, kind: 'exception', label: 'unwind' });
		}
	}
	return successors;
}

function successorKind(family: string, label: string): ControlFlowEdgeKind {
	const normalized = label.toLowerCase();
	if (family === 'assert') {
		return normalized === 'success' || normalized === 'true' ? 'true' : 'exception';
	}
	if (family === 'yield') {
		return normalized === 'drop' ? 'exception' : 'unconditional';
	}
	if (family === 'drop' || normalized === 'return') {
		return normalized === 'unwind' ? 'exception' : 'return';
	}
	if (normalized === 'unwind') {
		return 'exception';
	}
	if (normalized === 'true') {
		return 'true';
	}
	if (normalized === 'false') {
		return 'false';
	}
	return 'unconditional';
}

function successorLabel(family: string, label: string): string | undefined {
	const normalized = label.toLowerCase();
	if (family === 'switch') {
		return label;
	}
	if (
		family === 'assert' ||
		family === 'yield' ||
		family === 'drop' ||
		normalized === 'return' ||
		normalized === 'unwind'
	) {
		return label;
	}
	return undefined;
}

function parseFunctionLabel(line: string): string | undefined {
	const match = /^\s*fn\s+(.+?)(?=\s*\()/.exec(line);
	if (!match) {
		return undefined;
	}
	const candidate = match[1].trim();
	return candidate || undefined;
}

function parseSourceSpan(line: string): SourceSpan | undefined {
	const commentStart = findLineComment(line);
	if (commentStart < 0) {
		return undefined;
	}
	let comment = line.slice(commentStart + 2).trim();
	const at = comment.lastIndexOf(' at ');
	if (at >= 0) {
		comment = comment.slice(at + 4).trim();
	} else if (comment.startsWith('at ')) {
		comment = comment.slice(3).trim();
	}
	const match = /^(.+?):(\d+):(\d+)(?:\s*:\s*(\d+):(\d+))?\s*$/.exec(comment);
	if (!match) {
		return undefined;
	}
	const lineNumber = Number.parseInt(match[2], 10);
	const columnNumber = Number.parseInt(match[3], 10);
	if (lineNumber < 1 || columnNumber < 1) {
		return undefined;
	}
	const endLine = match[4] === undefined ? undefined : Number.parseInt(match[4], 10);
	const endColumn = match[5] === undefined ? undefined : Number.parseInt(match[5], 10);
	if ((endLine !== undefined && endLine < lineNumber) || (endColumn !== undefined && endColumn < 1)) {
		return undefined;
	}
	return {
		filename: match[1].trim(),
		line: lineNumber,
		column: columnNumber,
		...(endLine === undefined ? {} : { endLine }),
		...(endColumn === undefined ? {} : { endColumn }),
	};
}

function sourceLocation(span: SourceSpan, workingDirectory: string): ControlFlowSourceLocation {
	return {
		uri: compilerSourceUri(span.filename, workingDirectory),
		line: span.line - 1,
		column: span.column - 1,
		...(span.endLine === undefined ? {} : { endLine: span.endLine - 1 }),
		...(span.endColumn === undefined ? {} : { endColumn: span.endColumn - 1 }),
	};
}

function stripComment(line: string): string {
	const index = findLineComment(line);
	return index < 0 ? line : line.slice(0, index);
}

function findLineComment(line: string): number {
	let quote: 'single' | 'double' | undefined;
	let escaped = false;
	for (let index = 0; index < line.length; index++) {
		const character = line[index];
		if (quote) {
			if (escaped) {
				escaped = false;
			} else if (character === '\\') {
				escaped = true;
			} else if ((quote === 'single' && character === "'") || (quote === 'double' && character === '"')) {
				quote = undefined;
			}
			continue;
		}
		if (character === "'") {
			quote = 'single';
		} else if (character === '"') {
			quote = 'double';
		} else if (character === '/' && line[index + 1] === '/') {
			return index;
		}
	}
	return -1;
}

function braceDelta(line: string): number {
	let delta = 0;
	let quote: 'single' | 'double' | undefined;
	let escaped = false;
	for (let index = 0; index < line.length; index++) {
		const character = line[index];
		if (!quote && character === '/' && line[index + 1] === '/') {
			break;
		}
		if (quote) {
			if (escaped) {
				escaped = false;
			} else if (character === '\\') {
				escaped = true;
			} else if ((quote === 'single' && character === "'") || (quote === 'double' && character === '"')) {
				quote = undefined;
			}
			continue;
		}
		if (character === "'") {
			quote = 'single';
		} else if (character === '"') {
			quote = 'double';
		} else if (character === '{') {
			delta++;
		} else if (character === '}') {
			delta--;
		}
	}
	return delta;
}

function findClosingBracket(line: string, start: number): number {
	let depth = 0;
	for (let index = start; index < line.length; index++) {
		if (line[index] === '[') {
			depth++;
		} else if (line[index] === ']') {
			depth--;
			if (depth === 0) {
				return index;
			}
		}
	}
	return -1;
}
