// Structured after Compiler Explorer's `lib/cfg/cfg-parsers/llvm-ir.ts`
// (BSD 2-Clause). See `DERIVED.md` for the provenance and the list of changes.

import type {
	ControlFlowEdge,
	ControlFlowGraph,
	ControlFlowNode,
	ControlFlowSourceLocation,
} from '../../../types/index.js';
import { GraphIdAllocator, NodeIdAllocator, splitLines } from '../cfg-parser-support.js';
import type { GraphParseResult } from '../control-flow-graph-model.js';
import { decodeLlvmName } from '../../compiler/llvm-names.js';
import { parseMetadata, type MetadataTable } from './llvm-debug-metadata.js';

/**
 * Builds control-flow graphs from textual LLVM IR.
 *
 * The decomposition follows upstream: find each `define`, cut its body at label
 * lines, and dispatch on the opcode of the block's terminator. Three things
 * differ, and they are why the parser is maintained here rather than called
 * through:
 *
 * - Terminators are located by scanning the block for the last line that starts
 *   one and joining through the end of the block. Upstream reads the last
 *   non-empty line and special-cases the four multi-line shapes it has seen
 *   (`switch`, `invoke`, `landingpad`, `callbr`); joining covers those and any
 *   other wrapping without enumerating it.
 * - Edges carry a typed kind and, for `switch` and `invoke`, the case value or
 *   the `normal`/`unwind` role. Upstream's edge is a colour, which conflates
 *   unconditional branches with switch cases and cleanup unwinds.
 * - Blocks keep their source position and the artifact lines they were built
 *   from, so a node can be opened in the editor.
 *
 * Malformed input is reported rather than thrown: upstream calls `assert(false)`
 * on an unexpected `br` and throws on an unknown terminator, which discards
 * every other function in the module.
 */
export function parseLlvmControlFlowGraphs(
	text: string,
	workingDirectory: string,
): GraphParseResult {
	const lines = splitLines(text);
	const metadata = parseMetadata(lines, workingDirectory);
	const diagnostics: string[] = [];
	const graphIds = new GraphIdAllocator('llvm');
	const graphs: ControlFlowGraph[] = [];

	for (const section of splitToFunctions(lines, diagnostics)) {
		const graph = parseFunction(section, lines, metadata, diagnostics, graphIds);
		if (graph) {
			graphs.push(graph);
		}
	}
	return { graphs, diagnostics };
}

interface FunctionSection {
	readonly name: string;
	readonly bodyStartLine: number;
	readonly endLine: number;
}

interface BasicBlockSection {
	readonly identity: string;
	/** The block header line, or the first body line for the implicit entry block. */
	readonly startLine: number;
	/** The first instruction line, after any header. */
	readonly bodyStartLine: number;
	readonly endLine: number;
}

interface EdgeSpec {
	readonly target: string;
	readonly kind: ControlFlowEdge['kind'];
	readonly label?: string;
}

interface TerminatorResult {
	readonly opcode?: string;
	readonly edges: readonly EdgeSpec[];
	readonly terminal?: ControlFlowNode['terminal'];
	readonly malformed?: string;
}

/**
 * Locates each function body.
 *
 * Upstream advances from a `define` to the next line that is exactly `}` and
 * assumes one is present. A dump can be truncated mid-function, so the scan
 * also stops at the next `define` and says which function was left partial.
 */
function splitToFunctions(lines: readonly string[], diagnostics: string[]): FunctionSection[] {
	const sections: FunctionSection[] = [];
	for (let line = 0; line < lines.length; line++) {
		if (!/^\s*define\b/u.test(lines[line])) {
			continue;
		}

		const headerStart = line;
		let openingLine = -1;
		for (let candidate = line; candidate < lines.length; candidate++) {
			if (findUnquotedCharacter(lines[candidate], '{') !== -1) {
				openingLine = candidate;
				break;
			}
			if (candidate > line && /^\s*(?:define|declare)\b/u.test(lines[candidate])) {
				break;
			}
		}
		if (openingLine === -1) {
			diagnostics.push(`LLVM function beginning on line ${headerStart + 1} has no body.`);
			continue;
		}

		const header = lines.slice(headerStart, openingLine + 1).join('\n');
		const functionName = parseFunctionName(header);
		if (!functionName) {
			diagnostics.push(`LLVM function beginning on line ${headerStart + 1} has no parseable name.`);
			line = openingLine;
			continue;
		}

		let closingLine = -1;
		let closed = false;
		for (let candidate = openingLine + 1; candidate < lines.length; candidate++) {
			if (/^\s*\}\s*(?:;.*)?$/u.test(lines[candidate])) {
				closingLine = candidate;
				closed = true;
				break;
			}
			if (candidate > openingLine && /^\s*define\b/u.test(lines[candidate])) {
				closingLine = candidate;
				break;
			}
		}
		if (closingLine === -1) {
			closingLine = lines.length;
		}
		if (!closed) {
			diagnostics.push(`LLVM function ${JSON.stringify(functionName)} has no closing brace; parsing the partial body.`);
		}
		sections.push({
			name: functionName,
			bodyStartLine: openingLine + 1,
			endLine: closingLine,
		});
		line = Math.max(line, closingLine - 1);
	}
	return sections;
}

function parseFunction(
	section: FunctionSection,
	lines: readonly string[],
	metadata: MetadataTable,
	diagnostics: string[],
	graphIds: GraphIdAllocator,
): ControlFlowGraph | undefined {
	const blocks = scanBlocks(section, lines);
	if (blocks.length === 0) {
		diagnostics.push(`LLVM function ${JSON.stringify(section.name)} has no basic blocks.`);
		return undefined;
	}
	const duplicateIdentity = firstDuplicate(blocks.map(block => block.identity));
	if (duplicateIdentity !== undefined) {
		diagnostics.push(
			`LLVM function ${JSON.stringify(section.name)} has duplicate basic-block identity ${JSON.stringify(duplicateIdentity)} and was omitted.`,
		);
		return undefined;
	}

	const nodeIds = new NodeIdAllocator();
	const nodes: ControlFlowNode[] = [];
	const blockIdByIdentity = new Map<string, string>();
	const terminators: TerminatorResult[] = [];
	let malformed = false;
	for (const [ordinal, block] of blocks.entries()) {
		const id = nodeIds.allocate(block.identity, ordinal);
		blockIdByIdentity.set(block.identity, id);
		const source = findBlockSource(block, lines, metadata);
		const terminator = parseTerminator(block, lines);
		terminators.push(terminator);
		if (terminator.malformed) {
			diagnostics.push(`LLVM function ${JSON.stringify(section.name)}, block ${JSON.stringify(block.identity)}: ${terminator.malformed}`);
			malformed = true;
		}
		nodes.push({
			id,
			label: blockLabel(block, lines),
			...(source ? { source } : {}),
			referencedArtifactLines: lineRange(block.startLine, block.endLine),
			...(terminator.terminal ? { terminal: terminator.terminal } : {}),
		});
	}

	const edges: ControlFlowEdge[] = [];
	for (const [ordinal, block] of blocks.entries()) {
		const terminator = terminators[ordinal];
		if (!terminator.opcode) {
			continue;
		}
		const from = nodes[ordinal].id;
		for (const edge of terminator.edges) {
			const to = blockIdByIdentity.get(edge.target);
			if (!to) {
				diagnostics.push(
					`LLVM function ${JSON.stringify(section.name)}, block ${JSON.stringify(block.identity)} references missing block ${JSON.stringify(edge.target)}.`,
				);
				malformed = true;
				continue;
			}
			edges.push({
				from,
				to,
				kind: edge.kind,
				...(edge.label === undefined ? {} : { label: edge.label }),
			});
		}
	}
	if (malformed) {
		diagnostics.push(`LLVM function ${JSON.stringify(section.name)} was omitted because its control-flow structure is malformed.`);
		return undefined;
	}

	return {
		id: graphIds.allocate(section.name),
		label: section.name,
		entryNodeId: nodes[0]?.id,
		nodes,
		edges,
	};
}

/**
 * Cuts a function body at its label lines.
 *
 * A body that starts with instructions has an unlabelled entry block, which
 * upstream identifies by asserting it is the first block; naming it `entry`
 * here keeps every node addressable by the same rule.
 */
function scanBlocks(section: FunctionSection, lines: readonly string[]): BasicBlockSection[] {
	const headers: Array<{ identity: string; line: number }> = [];
	for (let line = section.bodyStartLine; line < section.endLine; line++) {
		const header = parseBlockHeader(lines[line]);
		if (header) {
			headers.push({ ...header, line });
		}
	}

	if (headers.length === 0) {
		return section.bodyStartLine < section.endLine
			? [{
				identity: 'entry',
				startLine: section.bodyStartLine,
				bodyStartLine: section.bodyStartLine,
				endLine: section.endLine,
			}]
			: [];
	}

	const blocks: BasicBlockSection[] = [];
	if (headers[0].line > section.bodyStartLine) {
		blocks.push({
			identity: 'entry',
			startLine: section.bodyStartLine,
			bodyStartLine: section.bodyStartLine,
			endLine: headers[0].line,
		});
	}
	for (const [index, header] of headers.entries()) {
		blocks.push({
			identity: header.identity,
			startLine: header.line,
			bodyStartLine: header.line + 1,
			endLine: headers[index + 1]?.line ?? section.endLine,
		});
	}
	return blocks;
}

/**
 * Reads the function name out of an assembled `define` header.
 *
 * Upstream matches `@("?[^"]+"?)` against the `define` line alone, which stops
 * at the first quote inside an escaped name and misses a wrapped header.
 */
function parseFunctionName(header: string): string | undefined {
	const match = /@("(?:\\.|[^"\\])*"|[A-Za-z0-9$._-]+)\s*\(/u.exec(header);
	if (!match) {
		return undefined;
	}
	return decodeLlvmName(match[1]) || undefined;
}

/**
 * Renders a block as its LLVM label followed by the block's instructions, so a
 * graph node shows the IR it stands for rather than a bare block number.
 */
function blockLabel(block: BasicBlockSection, lines: readonly string[]): string {
	const body = lines
		.slice(block.bodyStartLine, block.endLine)
		.map(line => line.trimEnd())
		.filter(line => line.length > 0);
	// LLVM indents every instruction by the same amount. Dropping that shared
	// indent keeps the node narrow while preserving the deeper indentation of
	// continuation lines in multi-line terminators.
	const commonIndent = Math.min(
		...body.map(line => line.length - line.trimStart().length),
		Number.MAX_SAFE_INTEGER,
	);
	const text = body.map(line => line.slice(commonIndent)).join('\n');
	return text ? `${block.identity}:\n${text}` : `${block.identity}:`;
}

function parseBlockHeader(line: string): { readonly identity: string } | undefined {
	const match = /^\s*(?:("(?:\\.|[^"\\])*")|(%?[A-Za-z0-9$._-]+))\s*:\s*(?:;.*)?$/u.exec(line);
	if (!match) {
		return undefined;
	}
	const raw = match[1] ?? match[2];
	const identity = decodeLlvmName(raw.startsWith('%') ? raw.slice(1) : raw);
	return identity ? { identity } : undefined;
}

function findBlockSource(
	block: BasicBlockSection,
	lines: readonly string[],
	metadata: MetadataTable,
): ControlFlowSourceLocation | undefined {
	for (let line = block.startLine; line < block.endLine; line++) {
		const match = /!dbg\s+!(\d+)/u.exec(lines[line]);
		if (!match) {
			continue;
		}
		const source = metadata.get(Number.parseInt(match[1], 10));
		if (source) {
			return source;
		}
	}
	return undefined;
}

function parseTerminator(block: BasicBlockSection, lines: readonly string[]): TerminatorResult {
	let start = -1;
	let opcode: string | undefined;
	for (let line = block.startLine; line < block.endLine; line++) {
		const candidate = terminatorOpcode(stripLlvmComment(lines[line]));
		if (candidate) {
			start = line;
			opcode = candidate;
		}
	}
	if (start === -1 || !opcode) {
		return {
			edges: [],
			malformed: 'no recognized terminator was found',
		};
	}

	const terminatorText = lines
		.slice(start, block.endLine)
		.map(stripLlvmComment)
		.join(' ')
		.replace(/\s+/gu, ' ')
		.trim();
	return parseTerminatorText(opcode, terminatorText);
}

function terminatorOpcode(line: string): string | undefined {
	// An assignment may prefix invoke (or another terminator in malformed
	// output), while tail/musttail/notail are instruction modifiers.
	const match = /^\s*(?:[%@](?:"(?:\\.|[^"\\])*"|[^\s=]+)\s*=\s*)?(?:(?:tail|musttail|notail)\s+)?(br|switch|indirectbr|invoke|callbr|ret|resume|unreachable|catchret|cleanupret|catchswitch|unwind)\b/iu.exec(line);
	return match?.[1].toLowerCase();
}

function parseTerminatorText(opcode: string, text: string): TerminatorResult {
	switch (opcode) {
		case 'br': {
			const targets = labelReferences(text);
			if (targets.length === 1) {
				return { opcode, edges: [{ target: targets[0], kind: 'unconditional' }] };
			}
			if (targets.length === 2) {
				return {
					opcode,
					edges: [
						{ target: targets[0], kind: 'true' },
						{ target: targets[1], kind: 'false' },
					],
				};
			}
			if (targets.length > 2) {
				return { opcode, edges: [], malformed: `branch terminator has ${targets.length} label targets` };
			}
			return { opcode, edges: [], malformed: 'branch terminator has no label target' };
		}
		case 'switch': {
			const references = labelReferencesWithContext(text);
			if (references.length === 0) {
				return { opcode, edges: [], malformed: 'switch terminator has no label target' };
			}
			return {
				opcode,
				edges: references.map((reference, index) => ({
					target: reference.target,
					kind: 'unconditional' as const,
					label: index === 0 ? 'default' : reference.context,
				})),
			};
		}
		case 'indirectbr': {
			const targets = labelReferences(text);
			return targets.length > 0
				? { opcode, edges: targets.map(target => ({ target, kind: 'unconditional' as const })) }
				: { opcode, edges: [], malformed: 'indirectbr terminator has no label target' };
		}
		case 'invoke': {
			const normal = new RegExp(`\\bto\\s+label\\s+(${labelToken})`, 'u').exec(text);
			const unwind = new RegExp(`\\bunwind\\s+label\\s+(${labelToken})`, 'u').exec(text);
			const edges: EdgeSpec[] = [];
			if (normal) {
				edges.push({ target: decodeLlvmName(normal[1].slice(1)), kind: 'unconditional', label: 'normal' });
			}
			if (unwind) {
				edges.push({ target: decodeLlvmName(unwind[1].slice(1)), kind: 'exception', label: 'unwind' });
			}
			return edges.length > 0
				? { opcode, edges }
				: { opcode, edges, malformed: 'invoke terminator has no normal or unwind target' };
		}
		case 'callbr': {
			const normal = new RegExp(`\\bto\\s+label\\s+(${labelToken})`, 'u').exec(text);
			const references = labelReferences(text);
			const edges: EdgeSpec[] = [];
			if (normal) {
				edges.push({ target: decodeLlvmName(normal[1].slice(1)), kind: 'unconditional', label: 'normal' });
			}
			const seen = new Set(edges.map(edge => edge.target));
			for (const target of references) {
				if (!seen.has(target)) {
					edges.push({ target, kind: 'unconditional', label: 'indirect' });
					seen.add(target);
				}
			}
			return edges.length > 0
				? { opcode, edges }
				: { opcode, edges, malformed: 'callbr terminator has no label target' };
		}
		case 'catchret': {
			const match = new RegExp(`\\bto\\s+label\\s+(${labelToken})`, 'u').exec(text);
			return match
				? { opcode, edges: [{ target: decodeLlvmName(match[1].slice(1)), kind: 'unconditional' }] }
				: { opcode, edges: [], malformed: 'catchret terminator has no target' };
		}
		case 'cleanupret': {
			const match = new RegExp(`\\bunwind\\s+label\\s+(${labelToken})`, 'u').exec(text);
			if (match) {
				return { opcode, edges: [{ target: decodeLlvmName(match[1].slice(1)), kind: 'exception', label: 'unwind' }] };
			}
			return /\bunwind\s+to\s+caller\b/u.test(text)
				? { opcode, edges: [], terminal: 'resume' }
				: { opcode, edges: [], malformed: 'cleanupret terminator has no unwind target' };
		}
		case 'catchswitch': {
			const edges = labelReferences(text).map(target => ({
				target,
				kind: 'exception' as const,
			}));
			const unwindsToCaller = /\bunwind\s+to\s+caller\b/u.test(text);
			return edges.length > 0 || unwindsToCaller
				? { opcode, edges, ...(unwindsToCaller ? { terminal: 'resume' as const } : {}) }
				: { opcode, edges, malformed: 'catchswitch terminator has no handler or unwind target' };
		}
		case 'ret':
			return { opcode, edges: [], terminal: 'return' };
		case 'resume':
			return { opcode, edges: [], terminal: 'resume' };
		case 'unreachable':
			return { opcode, edges: [], terminal: 'unreachable' };
		case 'unwind':
			return { opcode, edges: [], terminal: 'throw' };
		default:
			return { opcode, edges: [], malformed: `unsupported terminator ${JSON.stringify(opcode)}` };
	}
}

// Label names are either a bare LLVM identifier or a quoted identifier.  The
// optional percent is retained in the token so callers can distinguish labels
// from ordinary words when extracting targets.
const labelToken = String.raw`%(?:"(?:\\.|[^"\\])*"|[A-Za-z0-9$._-]+)`;
const labelReferencePattern = new RegExp(`\\blabel\\s+(${labelToken})`, 'gu');

function labelReferences(text: string): string[] {
	return [...text.matchAll(labelReferencePattern)].map(match =>
		decodeLlvmName(match[1].slice(1)));
}

function labelReferencesWithContext(text: string): Array<{ readonly target: string; readonly context: string }> {
	const references: Array<{ target: string; context: string }> = [];
	const pattern = new RegExp(`([^,\\[]*?),\\s*label\\s+(${labelToken})`, 'gu');
	for (const match of text.matchAll(pattern)) {
		references.push({
			target: decodeLlvmName(match[2].slice(1)),
			context: match[1].trim() || 'case',
		});
	}
	// The default target precedes the case list and is not matched by the
	// context expression above.  It is deliberately returned first.
	const defaultMatch = new RegExp(`,\\s*label\\s+(${labelToken})\\s*\\[`, 'u').exec(text);
	if (defaultMatch) {
		const defaultTarget = decodeLlvmName(defaultMatch[1].slice(1));
		let defaultReferenceRemoved = false;
		return [
			{ target: defaultTarget, context: 'default' },
			...references.filter(reference => {
				if (!defaultReferenceRemoved && reference.target === defaultTarget) {
					defaultReferenceRemoved = true;
					return false;
				}
				return true;
			}),
		];
	}
	return labelReferences(text).map(target => ({ target, context: 'case' }));
}

function lineRange(start: number, end: number): number[] {
	return Array.from({ length: Math.max(0, end - start) }, (_value, index) => start + index);
}

function stripLlvmComment(line: string): string {
	let quoted = false;
	let escaped = false;
	for (let index = 0; index < line.length; index++) {
		const character = line[index];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (character === '\\') {
			escaped = true;
			continue;
		}
		if (character === '"') {
			quoted = !quoted;
		} else if (character === ';' && !quoted) {
			return line.slice(0, index);
		}
	}
	return line;
}

function findUnquotedCharacter(value: string, wanted: string): number {
	let quoted = false;
	let escaped = false;
	for (let index = 0; index < value.length; index++) {
		const character = value[index];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (character === '\\') {
			escaped = true;
			continue;
		}
		if (character === '"') {
			quoted = !quoted;
		} else if (character === wanted && !quoted) {
			return index;
		}
	}
	return -1;
}



function firstDuplicate(values: readonly string[]): string | undefined {
	const seen = new Set<string>();
	for (const value of values) {
		if (seen.has(value)) {
			return value;
		}
		seen.add(value);
	}
	return undefined;
}
