import type {
	ControlFlowEdge,
	ControlFlowEdgeKind,
	ControlFlowGraph,
	ControlFlowNode,
	ControlFlowSourceLocation,
} from '../../types/index.js';
import { compilerSourceUri, GraphIdAllocator, splitLines } from './cfg-parser-support.js';
import type { GraphParseResult } from './control-flow-graph-model.js';

/**
 * Parse the textual CFG emitted by GCC's tree dump pass.
 *
 * GCC has changed some of the decoration around CFG dumps over time, but the
 * function header, basic-block headers, and successor comments are stable
 * enough to form a useful (and deliberately conservative) parser.  In
 * particular, an unlabeled pair of successors is not treated as a true/false
 * pair: that ordering is not part of the dump contract.
 */
export function parseGccControlFlowGraphs(
	text: string,
	workingDirectory: string,
): GraphParseResult {
	const lines = splitLines(text);
	const sections = findFunctionSections(lines);
	const diagnostics: string[] = [];
	const graphs: ControlFlowGraph[] = [];
	const graphIds = new GraphIdAllocator('gcc');

	if (sections.length === 0) {
		if (text.trim()) {
			diagnostics.push('No GCC function sections were found in the compiler output.');
		}
		return { graphs, diagnostics };
	}

	for (const section of sections) {
		const parsed = parseFunction(section, lines, workingDirectory);
		diagnostics.push(...parsed.diagnostics.map(message =>
			`GCC function ${JSON.stringify(section.label)}: ${message}`));
		if (parsed.graph) {
			graphs.push({ ...parsed.graph, id: graphIds.allocate(section.label) });
		}
	}

	return { graphs, diagnostics };
}

interface FunctionSection {
	readonly label: string;
	readonly startLine: number;
	readonly endLine: number;
}

interface ParsedFunction {
	readonly graph?: ControlFlowGraph;
	readonly diagnostics: readonly string[];
}

interface MutableBlock {
	readonly key: string;
	readonly special?: 'ENTRY' | 'EXIT';
	headerLine: number;
	headerSeen?: boolean;
	readonly lines: number[];
	readonly statements: string[];
	readonly successorLines: number[];
	readonly successors: Successor[];
	readonly branchEvents: BranchEvent[];
	firstSource?: ControlFlowSourceLocation;
	terminal?: ControlFlowNode['terminal'];
}

interface Successor {
	readonly target: string;
	readonly line: number;
}

interface BranchEvent {
	readonly target: string;
	readonly line: number;
	readonly kind?: ControlFlowEdgeKind;
	readonly label?: string;
}

interface BlockDescriptor {
	readonly key: string;
	readonly special?: 'ENTRY' | 'EXIT';
}

const functionHeaderPattern = /^\s*;;\s*Function\s+(.+?)\s*$/i;
const blockHeaderPattern = /^\s*(?:<bb\s+(\d+)>|<?(ENTRY|EXIT)>?)(?:\s+\[[^\]]*\])?\s*:?\s*$/i;
const successorPattern = /^\s*;;\s*(?:<bb\s*)?(\d+|ENTRY|EXIT)\s+succ(?:essor)?s?\s*\{([^}]*)\}/i;
const successorStartPattern = /^\s*;;\s*(?:<bb\s*)?(\d+|ENTRY|EXIT)\s+succ(?:essor)?s?\s*\{/i;
const locationPattern = /(?:["']([^"']+)["']|((?:[A-Za-z]:[\\/]|\/(?![\\/\s])|\.\.?[\\/])[^\r\n;]*?)|([A-Za-z0-9_.+-]+(?:[\\/][^\s:;]+)*))\s*[:(]\s*(\d+)(?:\s*[: ,]\s*(\d+))?/g;


function findFunctionSections(lines: readonly string[]): FunctionSection[] {
	const starts: Array<{ label: string; line: number }> = [];
	for (const [line, text] of lines.entries()) {
		const match = functionHeaderPattern.exec(text);
		if (!match) {
			continue;
		}
		starts.push({ label: functionLabel(match[1]), line });
	}
	return starts.map((start, index) => ({
		label: start.label || `<function ${index + 1}>`,
		startLine: start.line,
		endLine: starts[index + 1]?.line ?? lines.length,
	}));
}

function functionLabel(header: string): string {
	let label = header.trim();
	// The parenthesized suffix is compiler metadata in a tree CFG header, e.g.
	// "foo (foo, funcdef_no=0, decl_uid=...)".  Do not strip a normal function
	// signature unless it contains one of the known metadata keys.
	const suffix = label.lastIndexOf(' (');
	if (suffix > 0 && (/\b(?:funcdef_no|decl_uid|cgraph_uid|symbol_order)\s*=/.test(label.slice(suffix))
		|| /^\s*\(null\)\s*$/i.test(label.slice(suffix)))) {
		label = label.slice(0, suffix).trim();
	}
	return label;
}

function parseFunction(
	section: FunctionSection,
	allLines: readonly string[],
	workingDirectory: string,
): ParsedFunction {
	const diagnostics: string[] = [];
	const blocks = new Map<string, MutableBlock>();
	const blockOrder: string[] = [];
	let current: MutableBlock | undefined;
	let pendingConditional: 'if' | 'else' | undefined;
	let duplicateBlock = false;
	let malformedSuccessorList = false;
	let headerCount = 0;

	for (let line = section.startLine; line < section.endLine; line++) {
		const text = allLines[line] ?? '';
		const header = blockHeader(text);
		if (header) {
			const existing = blocks.get(header.key);
			if (existing?.headerSeen) {
				duplicateBlock = true;
				diagnostics.push(`duplicate basic-block header ${JSON.stringify(header.key)} at output line ${line + 1}`);
				current = undefined;
				continue;
			}
			current = existing ?? {
				...header,
				headerLine: line,
				lines: [],
				statements: [],
				successorLines: [],
				successors: [],
				branchEvents: [],
			};
			current.headerLine = line;
			current.headerSeen = true;
			headerCount++;
			if (!current.lines.includes(line)) {
				current.lines.push(line);
			}
			if (!existing) {
				blocks.set(header.key, current);
				blockOrder.push(header.key);
			}
			pendingConditional = undefined;
			continue;
		}

		const successor = parseSuccessors(text);
		if (successor) {
			const source = getOrCreateBlock(
				blocks,
				blockOrder,
				blockDescriptor(successor.source),
				line,
			);
			source.successorLines.push(line);
			for (const target of successor.targets) {
				source.successors.push({ target, line });
			}
			continue;
		}
		if (successorStartPattern.test(text)) {
			diagnostics.push(`malformed successor list at output line ${line + 1}`);
			malformedSuccessorList = true;
			continue;
		}

		if (!current) {
			continue;
		}
		current.lines.push(line);
		const statement = text.trim();
		if (statement) {
			current.statements.push(statement);
		}
		const source = parseSourceLocation(text, workingDirectory);
		if (!current.firstSource && source) {
			current.firstSource = source;
		}
		const terminal = terminalKind(statement);
		if (terminal) {
			current.terminal = terminal;
		}

		const gotos = [...text.matchAll(/\bgoto\s+<bb\s+(\d+)>/gi)];
		if (gotos.length > 0) {
			for (const match of gotos) {
				const prefix = text.slice(0, match.index ?? 0);
				const target = normalizeBlockReference(match[1]);
				const isElse = /\belse\b/i.test(prefix);
				const isConditionalLine = /\bif\s*\(/i.test(prefix) || pendingConditional !== undefined;
				const kind: ControlFlowEdgeKind | undefined = isElse
					? 'false'
					: pendingConditional === 'else'
						? 'false'
						: isConditionalLine
							? 'true'
							: undefined;
				current.branchEvents.push({ target, line, kind });
			}
			pendingConditional = undefined;
		} else if (/\bif\s*\(/i.test(text)) {
			pendingConditional = 'if';
		} else if (/^\s*else\b/i.test(text)) {
			pendingConditional = 'else';
		}

		for (const event of parseSwitchEvents(text, line)) {
			current.branchEvents.push(event);
		}
	}

	if (blocks.size === 0 || headerCount === 0) {
		return { diagnostics: [...diagnostics, 'no basic-block headers were found'] };
	}
	if (duplicateBlock) {
		return { diagnostics: [...diagnostics, 'function contains duplicate basic-block headers'] };
	}
	if (malformedSuccessorList) {
		return { diagnostics: [...diagnostics, 'function contains a malformed successor list and was omitted'] };
	}

	// Successor comments are normally printed before the block bodies.  Their
	// source blocks are therefore resolved after all headers have been seen.
	for (const block of blocks.values()) {
		for (const successor of block.successors) {
			ensureBlock(blocks, blockOrder, successor.target, successor.line);
		}
		for (const event of block.branchEvents) {
			ensureBlock(blocks, blockOrder, event.target, event.line);
		}
	}

	const orderedBlockKeys = [...blocks.values()]
		.sort((left, right) => {
			if (left.headerSeen !== right.headerSeen) {
				return left.headerSeen ? -1 : 1;
			}
			return left.headerLine - right.headerLine || blockOrder.indexOf(left.key) - blockOrder.indexOf(right.key);
		})
		.map(block => block.key);
	const nodes: ControlFlowNode[] = orderedBlockKeys.map(key => {
		const block = blocks.get(key)!;
		const label = block.special ?? key;
		const statements = block.statements
			.filter(statement => !/^;;/.test(statement))
			.filter(statement => statement !== '{' && statement !== '}')
			.join('\n')
			.trim();
		const node: ControlFlowNode = {
			id: key,
			label: statements ? `${label}\n${statements}` : label,
			referencedArtifactLines: uniqueSorted([
				...block.lines,
				...block.successorLines,
			]),
		};
		return block.firstSource || block.terminal
			? {
				...node,
				...(block.firstSource ? { source: block.firstSource } : {}),
				...(block.terminal ? { terminal: block.terminal } : {}),
			}
			: node;
	});

	const edges: ControlFlowEdge[] = [];
	for (const block of blocks.values()) {
		const events = block.branchEvents;
		const usedEvents = new Set<number>();
		for (const successor of block.successors) {
			const eventIndex = events.findIndex((event, index) =>
				!usedEvents.has(index) && event.target === successor.target);
			const event = eventIndex >= 0 ? events[eventIndex] : undefined;
			if (event) {
				usedEvents.add(eventIndex);
			}
			const kind = event?.kind ?? edgeKindForTerminal(block, successor.target);
			addEdge(edges, block.key, successor.target, kind, event?.label);
		}
		for (const [eventIndex, event] of events.entries()) {
			if (usedEvents.has(eventIndex)) {
				continue;
			}
			addEdge(edges, block.key, event.target, event.kind ?? edgeKindForTerminal(block, event.target), event.label);
		}

		// A dump normally contains a successor comment for every block.  For a
		// partial hand-written dump, retaining an obvious sequential fallthrough
		// is more useful than silently dropping it; terminal blocks never receive
		// this inferred edge.
		if (block.successors.length === 0 && block.branchEvents.length === 0 && !block.terminal) {
			const index = orderedBlockKeys.indexOf(block.key);
			const next = index >= 0 ? orderedBlockKeys[index + 1] : undefined;
			if (next) {
				addEdge(edges, block.key, next, 'fallthrough');
			}
		}
	}

	const entryNodeId = blocks.has('ENTRY')
		? 'ENTRY'
		: orderedBlockKeys.find(key => key !== 'EXIT');
	const graph: ControlFlowGraph = {
		id: `gcc:${section.label}`,
		label: section.label,
		nodes,
		edges,
		...(entryNodeId ? { entryNodeId } : {}),
	};
	return {
		graph,
		diagnostics,
	};
}

function blockHeader(text: string): BlockDescriptor | undefined {
	const match = blockHeaderPattern.exec(text);
	if (!match) {
		return undefined;
	}
	if (match[1] !== undefined) {
		return blockDescriptor(normalizeBlockReference(match[1]));
	}
	const special = match[2]?.toUpperCase() as 'ENTRY' | 'EXIT' | undefined;
	return special ? { key: special, special } : undefined;
}

function parseSuccessors(text: string): { source: string; targets: string[] } | undefined {
	const match = successorPattern.exec(text);
	if (!match) {
		return undefined;
	}
	const source = normalizeBlockReference(match[1]);
	const targets = [...match[2].matchAll(/(?:<bb\s*)?(\d+|ENTRY|EXIT)\b/gi)]
		.map(item => normalizeBlockReference(item[1]))
		.filter((value, index, all) => all.indexOf(value) === index);
	return { source, targets };
}

function parseSwitchEvents(text: string, line: number): BranchEvent[] {
	const events: BranchEvent[] = [];
	const switchPattern = /\b(default|case\s+[^:;,>]+)\s*:\s*<bb\s+(\d+)>/gi;
	for (const match of text.matchAll(switchPattern)) {
		events.push({
			target: normalizeBlockReference(match[2]),
			line,
			label: match[1].trim(),
		});
	}
	return events;
}

function blockDescriptor(reference: string): BlockDescriptor {
	return reference === 'ENTRY' || reference === 'EXIT'
		? { key: reference, special: reference }
		: { key: reference };
}

function normalizeBlockReference(value: string): string {
	const normalized = value.toUpperCase();
	return normalized === 'ENTRY' || normalized === 'EXIT'
		? normalized
		: Number.parseInt(value, 10) === 0
			? 'ENTRY'
			: Number.parseInt(value, 10) === 1
				? 'EXIT'
				: `bb${Number.parseInt(value, 10)}`;
}

function getOrCreateBlock(
	blocks: Map<string, MutableBlock>,
	blockOrder: string[],
	descriptor: BlockDescriptor,
	line: number,
): MutableBlock {
	const existing = blocks.get(descriptor.key);
	if (existing) {
		return existing;
	}
	const block: MutableBlock = {
		...descriptor,
		headerLine: line,
		headerSeen: false,
		lines: [],
		statements: [],
		successorLines: [],
		successors: [],
		branchEvents: [],
	};
	blocks.set(descriptor.key, block);
	blockOrder.push(descriptor.key);
	return block;
}

function ensureBlock(
	blocks: Map<string, MutableBlock>,
	blockOrder: string[],
	reference: string,
	line: number,
): MutableBlock {
	const block = getOrCreateBlock(blocks, blockOrder, blockDescriptor(reference), line);
	if (!block.lines.includes(line)) {
		block.lines.push(line);
	}
	return block;
}

function addEdge(
	edges: ControlFlowEdge[],
	from: string,
	to: string,
	kind: ControlFlowEdgeKind,
	label?: string,
): void {
	if (edges.some(edge => edge.from === from && edge.to === to && edge.kind === kind && edge.label === label)) {
		return;
	}
	edges.push(label === undefined ? { from, to, kind } : { from, to, kind, label });
}

function edgeKindForTerminal(block: MutableBlock, target: string): ControlFlowEdgeKind {
	if (target === 'EXIT' && block.terminal === 'return') {
		return 'return';
	}
	if (block.terminal === 'throw' || block.terminal === 'resume') {
		return 'exception';
	}
	return 'unconditional';
}

function terminalKind(statement: string): ControlFlowNode['terminal'] | undefined {
	if (/^(?:return\b|__builtin_return\b)/i.test(statement)) {
		return 'return';
	}
	if (/^(?:throw\b|__cxa_throw\b)/i.test(statement)) {
		return 'throw';
	}
	if (/^(?:resume\b|eh_dispatch\b)/i.test(statement)) {
		return 'resume';
	}
	if (/^(?:__builtin_unreachable\b|unreachable\b|abort\s*\()/i.test(statement)) {
		return 'unreachable';
	}
	return undefined;
}

function parseSourceLocation(
	text: string,
	workingDirectory: string,
): ControlFlowSourceLocation | undefined {
	locationPattern.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = locationPattern.exec(text)) !== null) {
		const filename = (match[1] ?? match[2] ?? match[3] ?? '').trim();
		if (!filename || /^\d+$/.test(filename)) {
			continue;
		}
		const line = Number.parseInt(match[4], 10);
		const rawColumn = match[5] === undefined ? undefined : Number.parseInt(match[5], 10);
		if (!Number.isSafeInteger(line) || line < 1
			|| (rawColumn !== undefined && (!Number.isSafeInteger(rawColumn) || rawColumn < 1))) {
			continue;
		}
		return {
			uri: compilerSourceUri(filename, workingDirectory),
			line: line - 1,
			column: rawColumn === undefined ? 0 : rawColumn - 1,
		};
	}
	return undefined;
}



function uniqueSorted(values: readonly number[]): number[] {
	return [...new Set(values)].sort((left, right) => left - right);
}
