import type {
	ControlFlowEdge,
	ControlFlowGraph,
	ControlFlowNode,
} from '../../../types/index.js';
import { GraphIdAllocator, splitLines } from '../cfg-parser-support.js';
import type { GraphParseResult } from '../control-flow-graph-model.js';

interface Block {
	readonly id: string;
	readonly lines: number[];
	readonly text: string[];
	firstSourceLine?: number;
}

interface Snapshot {
	readonly name: string;
	readonly blocks: Block[];
}

const functionPattern = /^(\S+)\s+func\(/u;
const blockPattern = /^\s*(b\d+):(?:\s+.*)?$/u;
const sourceLinePattern = /\([+]?([1-9]\d*)\)/u;

/** Parses the final textual SSA snapshot emitted by `GOSSAFUNC=<name>+`. */
export function parseGoSsaControlFlowGraphs(
	text: string,
	sourceUri: string,
): GraphParseResult {
	const lines = splitLines(text);
	const latest = new Map<string, Snapshot>();
	const order: string[] = [];
	let snapshot: Snapshot | undefined;
	let block: Block | undefined;

	const finish = () => {
		if (!snapshot || snapshot.blocks.length === 0) {
			return;
		}
		if (!latest.has(snapshot.name)) {
			order.push(snapshot.name);
		}
		latest.set(snapshot.name, snapshot);
	};

	for (const [lineNumber, line] of lines.entries()) {
		const functionMatch = functionPattern.exec(line);
		if (functionMatch) {
			finish();
			snapshot = { name: functionMatch[1], blocks: [] };
			block = undefined;
			continue;
		}
		if (/^genssa\s+/u.test(line) || /^\s*pass\s+.+\s+begin\s*$/u.test(line)) {
			finish();
			snapshot = undefined;
			block = undefined;
			continue;
		}
		if (!snapshot) {
			continue;
		}
		const blockMatch = blockPattern.exec(line);
		if (blockMatch) {
			block = { id: blockMatch[1], lines: [lineNumber], text: [line.trim()] };
			snapshot.blocks.push(block);
			continue;
		}
		if (!block || /^name\s+/u.test(line)) {
			continue;
		}
		block.lines.push(lineNumber);
		block.text.push(line.trim());
		const sourceLine = sourceLinePattern.exec(line)?.[1];
		if (block.firstSourceLine === undefined && sourceLine) {
			block.firstSourceLine = Number.parseInt(sourceLine, 10) - 1;
		}
	}
	finish();

	const diagnostics: string[] = [];
	const graphIds = new GraphIdAllocator('go-ssa');
	const graphs = order.flatMap(name => {
		const candidate = latest.get(name)!;
		const graph = graphFromSnapshot(candidate, sourceUri, graphIds, diagnostics);
		return graph ? [graph] : [];
	});
	if (graphs.length === 0 && text.trim()) {
		diagnostics.push(
			'No Go SSA basic blocks were found. Ensure GOSSAFUNC names a function compiled from this source file.',
		);
	}
	return { graphs, diagnostics };
}

function graphFromSnapshot(
	snapshot: Snapshot,
	sourceUri: string,
	graphIds: GraphIdAllocator,
	diagnostics: string[],
): ControlFlowGraph | undefined {
	const ids = new Set(snapshot.blocks.map(block => block.id));
	const nodes: ControlFlowNode[] = snapshot.blocks.map(block => {
		const terminator = withoutSourcePosition(block.text.at(-1) ?? '');
		const terminal = /^Ret\b/u.test(terminator)
			? 'return' as const
			: /^(?:Exit|Invalid)\b/u.test(terminator)
				? 'unreachable' as const
				: undefined;
		return {
			id: block.id,
			label: block.text.join('\n'),
			referencedArtifactLines: block.lines,
			...(block.firstSourceLine === undefined ? {} : {
				source: { uri: sourceUri, line: block.firstSourceLine, column: 0 },
			}),
			...(terminal ? { terminal } : {}),
		};
	});
	if (nodes.length === 0) {
		return undefined;
	}

	const edges: ControlFlowEdge[] = [];
	for (const block of snapshot.blocks) {
		const terminator = withoutSourcePosition(block.text.at(-1) ?? '');
		const targets = [...terminator.matchAll(/\b(b\d+)\b/gu)]
			.map(match => match[1])
			.filter(target => target !== block.id);
		for (const [index, target] of [...new Set(targets)].entries()) {
			if (!ids.has(target)) {
				diagnostics.push(
					`Go SSA function ${JSON.stringify(snapshot.name)}, block ${block.id}: no block ${target} exists.`,
				);
				continue;
			}
			const conditional = /^(?:If|Defer)\b/u.test(terminator) && targets.length >= 2;
			edges.push({
				from: block.id,
				to: target,
				kind: conditional ? (index === 0 ? 'true' : 'false') : 'unconditional',
			});
		}
	}

	return {
		id: graphIds.allocate(snapshot.name),
		label: snapshot.name,
		entryNodeId: ids.has('b1') ? 'b1' : nodes[0].id,
		nodes,
		edges,
	};
}

function withoutSourcePosition(line: string): string {
	return line.replace(/^\([+]?\d+\)\s*/u, '');
}
