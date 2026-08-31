// Derived from Compiler Explorer's `lib/cfg/cfg-parsers/base.ts` (BSD 2-Clause).
// See `DERIVED.md` in this directory for the provenance and the list of changes.

import type {
	ControlFlowEdge,
	ControlFlowGraph,
	ControlFlowNode,
	ControlFlowSourceLocation,
} from '../../../types/index.js';
import { GraphIdAllocator, NodeIdAllocator } from '../cfg-parser-support.js';
import type { GraphParseResult } from '../control-flow-graph-model.js';
import type { AssemblyLine } from './assembly-line.js';
import { InstructionSetInfo } from './instruction-sets.js';

/** A half-open `[start, end)` range of assembly lines. */
export interface Range {
	readonly start: number;
	readonly end: number;
}

/** A block delimited by compiler-emitted labels, before branch splitting. */
interface LabelledBlock {
	nameId: string;
	start: number;
	end: number;
	readonly branchPositions: number[];
}

/** A block with a single entry and a single exit. */
interface CanonicalBlock {
	nameId: string;
	readonly start: number;
	readonly end: number;
}

/**
 * Builds control-flow graphs from an assembly listing.
 *
 * The decomposition is upstream's: keep the lines that are code, cut the
 * listing into functions at label boundaries, cut each function into blocks at
 * compiler labels, then cut each block again after every branch. What differs
 * is the output. Upstream emits `{id, label}` nodes and colour-coded edges for
 * a vis.js pane; this emits the extension's graph model, so a node keeps the
 * artifact lines it was built from and the source position the compiler
 * attributed to them, and an edge keeps a typed kind instead of a colour.
 *
 * Subclasses supply the dialect: which lines are code, what a label looks like,
 * and how to read a branch target out of an instruction.
 */
export class AssemblyCfgParser {
	/** Prefixes graph IDs so graphs from different dialects never collide. */
	static readonly dialect: string = 'asm';

	constructor(protected readonly instructionSet: InstructionSetInfo) {}

	parse(assembly: readonly AssemblyLine[]): GraphParseResult {
		const diagnostics: string[] = [];
		const code = this.filterData(assembly);
		const graphIds = new GraphIdAllocator((this.constructor as typeof AssemblyCfgParser).dialect);
		const graphs: ControlFlowGraph[] = [];

		for (const fn of this.splitToFunctions(code)) {
			const name = this.functionName(code, fn);
			// A malformed function must not suppress the rest of the listing, so
			// each one is built in isolation and reported on its own.
			try {
				const graph = this.generateFunctionGraph(code, fn, name, graphIds, diagnostics);
				if (graph) {
					graphs.push(graph);
				}
			} catch (error) {
				diagnostics.push(
					`Assembly function ${JSON.stringify(name)} was omitted: ${
						error instanceof Error ? error.message : String(error)
					}.`,
				);
			}
		}
		return { graphs, diagnostics };
	}

	/** Keeps the lines that carry code, dropping directives and stray labels. */
	protected filterData(assembly: readonly AssemblyLine[]): AssemblyLine[] {
		const jumpLabel = /\.L\d+:/u;
		return this.filterTextSection(assembly).filter(
			(line) =>
				line.text && (line.source !== undefined || jumpLabel.test(line.text) || this.isFunctionName(line)),
		);
	}

	protected splitToFunctions(assembly: readonly AssemblyLine[]): Range[] {
		if (assembly.length === 0) {
			return [];
		}
		const result: Range[] = [];
		let start = 0;
		for (let cursor = 1; cursor < assembly.length; cursor++) {
			if (this.isFunctionEnd(assembly[cursor].text)) {
				if (cursor > start + 1) {
					result.push({ start, end: cursor });
				}
				start = cursor;
			}
		}
		if (assembly.length > start + 1) {
			result.push({ start, end: assembly.length });
		}
		return result;
	}

	/**
	 * The name a function is presented under, which is also the name of its
	 * entry block. Upstream uses the raw label line, so a graph ends up titled
	 * `classify:` or `classify PROC`.
	 */
	protected functionName(assembly: readonly AssemblyLine[], fn: Range): string {
		return assembly[fn.start].text.trim().replace(/:$/u, '');
	}

	protected isFunctionName(line: AssemblyLine): boolean {
		return !line.text.trim().startsWith('.') || line.text.startsWith('.omp_');
	}

	protected isFunctionEnd(text: string): boolean {
		return text[0] !== ' ' && (text[0] !== '.' || text.startsWith('.omp_')) && text.includes(':');
	}

	protected isBasicBlockEnd(instruction: string, previousInstruction: string): boolean {
		return instruction[0] === '.' || previousInstruction.includes(' ret');
	}

	/** The name a block inherits when it starts at `firstInstruction`. */
	protected blockId(firstInstruction: string): string {
		return firstInstruction;
	}

	/** The first instruction of a block whose header is on `headerLine`. */
	protected blockFirstInstructionLine(headerLine: number): number {
		return headerLine + 1;
	}

	/**
	 * The block a branch instruction targets, or `undefined` when the target is
	 * not statically known.
	 *
	 * Upstream returns `String(inst.match(...)) + ':'`, which yields the literal
	 * string `"null:"` for an indirect jump such as a switch jump table and
	 * produces an edge to a node that does not exist. Returning `undefined`
	 * instead lets the caller record a diagnostic and keep the rest of the graph.
	 */
	protected extractJumpTarget(instruction: string): string | undefined {
		return instruction.match(/\.L\d+/u)?.[0].concat(':');
	}

	/** Separates a synthesised block name from its originating label. */
	protected labelSeparator(): string {
		return '@';
	}

	protected asmDirective(text: string): string | null {
		return /^\s*(\.[^ L]\S*)/u.exec(text)?.[1] ?? null;
	}

	protected filterTextSection(data: readonly AssemblyLine[]): AssemblyLine[] {
		let useCurrentSection = true;
		const result: AssemblyLine[] = [];
		for (const line of data) {
			const directive = this.asmDirective(line.text);
			if (directive === '.text' || directive === '.data') {
				useCurrentSection = directive === '.text';
			} else if (directive === '.section') {
				// Matching the name only: extracting it would have to account for
				// demangled names containing arbitrary punctuation.
				useCurrentSection = /\.section\s*"?\.text/u.test(line.text);
			} else if (useCurrentSection) {
				result.push(line);
			}
		}
		return result;
	}

	private generateFunctionGraph(
		code: readonly AssemblyLine[],
		fn: Range,
		name: string,
		graphIds: GraphIdAllocator,
		diagnostics: string[],
	): ControlFlowGraph | undefined {
		const blocks = this.splitToLabelledBlocks(code, fn, name).flatMap((block) => this.splitAtBranches(block));
		if (blocks.length === 0) {
			return undefined;
		}
		this.nameFallthroughTargets(code, blocks);

		const nodeIds = new NodeIdAllocator();
		const nodeIdByName = new Map<string, string>();
		const nodes: ControlFlowNode[] = [];
		for (const [ordinal, block] of blocks.entries()) {
			const id = nodeIds.allocate(block.nameId, ordinal);
			// A repeated block name means the listing is ambiguous about which
			// block a branch reaches; the first one keeps the name.
			if (!nodeIdByName.has(block.nameId)) {
				nodeIdByName.set(block.nameId, id);
			}
			nodes.push(this.makeNode(id, code, block));
		}

		const edges = this.makeEdges(code, blocks, nodes, nodeIdByName, name, diagnostics);
		return {
			id: graphIds.allocate(name),
			label: name,
			entryNodeId: nodes[0].id,
			nodes,
			edges,
		};
	}

	private splitToLabelledBlocks(code: readonly AssemblyLine[], fn: Range, functionName: string): LabelledBlock[] {
		let cursor = fn.start;
		if (cursor === fn.end) {
			return [];
		}
		cursor++;

		const result: LabelledBlock[] = [];
		let current: LabelledBlock = {
			nameId: functionName,
			start: cursor,
			end: fn.end,
			branchPositions: [],
		};
		while (cursor < fn.end) {
			const instruction = code[cursor].text;
			const previous = code[cursor - 1]?.text ?? '';
			if (this.isBasicBlockEnd(instruction, previous)) {
				result.push({ ...current, end: cursor });
				current = {
					nameId: this.blockId(instruction),
					start: this.blockFirstInstructionLine(cursor),
					end: fn.end,
					branchPositions: [],
				};
			} else if (this.instructionSet.isJump(instruction)) {
				current.branchPositions.push(cursor);
			}
			cursor++;
		}
		result.push({ ...current, end: fn.end });
		return result.filter((block) => block.end > block.start);
	}

	/**
	 * Cuts a labelled block after each branch, so every resulting block ends with
	 * at most one control transfer.
	 */
	private splitAtBranches(block: LabelledBlock): CanonicalBlock[] {
		const positions = [...block.branchPositions];
		// A branch that is already the last instruction does not split anything.
		if (positions.at(-1) === block.end - 1) {
			positions.pop();
		}
		if (positions.length === 0) {
			return [{ nameId: block.nameId, start: block.start, end: block.end }];
		}

		const result: CanonicalBlock[] = [{ nameId: block.nameId, start: block.start, end: positions[0] + 1 }];
		for (const [index, position] of positions.entries()) {
			result.push({
				nameId: `${block.nameId}${this.labelSeparator()}${position + 1}`,
				start: position + 1,
				end: (positions[index + 1] ?? block.end - 1) + 1,
			});
		}
		return result;
	}

	/**
	 * Gives every not-taken branch target a name.
	 *
	 * Upstream does this from inside edge construction, after the nodes have
	 * already been named, so a block renamed here would be unreachable from the
	 * edge that renamed it. Running it as its own pass before nodes are built
	 * keeps names and edges consistent by construction.
	 */
	private nameFallthroughTargets(code: readonly AssemblyLine[], blocks: CanonicalBlock[]): void {
		for (const [index, block] of blocks.entries()) {
			const next = blocks[index + 1];
			if (!next || this.instructionSet.classify(code[block.end - 1].text) !== 'conditional-jump') {
				continue;
			}
			const following = code[block.end];
			if (following && this.isBasicBlockEnd(following.text, '')) {
				continue;
			}
			const separator = this.labelSeparator();
			const cut = block.nameId.indexOf(separator);
			next.nameId =
				cut === -1
					? `${block.nameId}${separator}${block.end}`
					: `${block.nameId.slice(0, cut + 1)}${block.end}`;
		}
	}

	private makeNode(id: string, code: readonly AssemblyLine[], block: CanonicalBlock): ControlFlowNode {
		const lines = code.slice(block.start, block.end);
		const header = block.nameId.includes(':') ? block.nameId : `${block.nameId}:`;
		const source = lines.find((line) => line.source)?.source;
		const terminal =
			this.instructionSet.classify(lines.at(-1)?.text ?? '') === 'return' ? ('return' as const) : undefined;
		return {
			id,
			label: `${header}\n${lines.map((line) => line.text).join('\n')}`,
			...(source ? { source: source satisfies ControlFlowSourceLocation } : {}),
			referencedArtifactLines: lines.map((line) => line.artifactLine),
			...(terminal ? { terminal } : {}),
		};
	}

	private makeEdges(
		code: readonly AssemblyLine[],
		blocks: readonly CanonicalBlock[],
		nodes: readonly ControlFlowNode[],
		nodeIdByName: ReadonlyMap<string, string>,
		functionName: string,
		diagnostics: string[],
	): ControlFlowEdge[] {
		const edges: ControlFlowEdge[] = [];
		const connect = (fromOrdinal: number, target: string | undefined, kind: ControlFlowEdge['kind']) => {
			const to = target === undefined ? undefined : nodeIdByName.get(target);
			if (to === undefined) {
				diagnostics.push(
					`Assembly function ${JSON.stringify(functionName)}, block ${JSON.stringify(
						blocks[fromOrdinal].nameId,
					)}: ${
						target === undefined
							? 'the branch target is not statically known'
							: `no block named ${JSON.stringify(target)} exists`
					}.`,
				);
				return;
			}
			edges.push({ from: nodes[fromOrdinal].id, to, kind });
		};

		for (const [ordinal, block] of blocks.entries()) {
			const lastInstruction = code[block.end - 1].text;
			switch (this.instructionSet.classify(lastInstruction)) {
				case 'unconditional-jump':
					connect(ordinal, this.extractJumpTarget(lastInstruction), 'unconditional');
					break;
				case 'conditional-jump':
					connect(ordinal, this.extractJumpTarget(lastInstruction), 'true');
					connect(ordinal, blocks[ordinal + 1]?.nameId, 'false');
					break;
				case 'linear': {
					// Fallthrough is possible only within this function. Looking at
					// `code[block.end]` for the final block crosses the half-open
					// function range and, for MSVC, mistakes `name ENDP` for a target.
					const next = blocks[ordinal + 1];
					if (next) {
						connect(ordinal, next.nameId, 'fallthrough');
					}
					break;
				}
				case 'return':
					break;
			}
		}
		return edges;
	}
}
