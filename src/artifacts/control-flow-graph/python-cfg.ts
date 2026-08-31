import type {
	ControlFlowEdge,
	ControlFlowGraph,
	ControlFlowNode,
	ControlFlowSourceLocation,
} from '../../types/index.js';
import type { ArtifactProducer } from '../../toolchains/toolchain-map.js';
import { artifactProducer } from '../core/compiler-output-producer.js';
import { compilerSourceUri, GraphIdAllocator } from '../control-flow-graph/cfg-parser-support.js';
import type { GraphParseResult } from '../control-flow-graph/control-flow-graph-model.js';

/** Python inspects compiled code objects but never imports or executes the source module. */
export const pythonCfgHelper = String.raw`
import dis,json,sys,tokenize,types
filename=sys.argv[1]
with tokenize.open(filename) as source_file:
    source=source_file.read()
root=compile(source,filename,"exec",dont_inherit=True)
jump_opcodes=set(dis.hasjabs)|set(dis.hasjrel)
unconditional_jump_opcodes={
    opcode for name,opcode in dis.opmap.items()
    if opcode in jump_opcodes and name.startswith("JUMP") and "IF" not in name
}
terminal_opcodes={
    opcode for name,opcode in dis.opmap.items()
    if (name.startswith("RETURN") and name!="RETURN_GENERATOR") or "RAISE" in name
}

def positive_line(value):
    return value if isinstance(value,int) and not isinstance(value,bool) and value>0 else None

def nonnegative_position(value):
    return value if isinstance(value,int) and not isinstance(value,bool) and value>=0 else None

def instruction_record(instruction):
    positions=getattr(instruction,"positions",None)
    opname=instruction.opname
    is_jump=instruction.opcode in jump_opcodes and isinstance(instruction.argval,int)
    conditional=is_jump and instruction.opcode not in unconditional_jump_opcodes
    terminal=instruction.opcode in terminal_opcodes
    starts_line=instruction.starts_line
    if isinstance(starts_line,bool):
        starts_line=getattr(positions,"lineno",None) if starts_line else None
    return {
        "offset":instruction.offset,
        "opname":opname,
        "argrepr":instruction.argrepr,
        "startsLine":positive_line(starts_line),
        "line":positive_line(getattr(positions,"lineno",None)),
        "endLine":positive_line(getattr(positions,"end_lineno",None)),
        "column":nonnegative_position(getattr(positions,"col_offset",None)),
        "endColumn":nonnegative_position(getattr(positions,"end_col_offset",None)),
        "isJumpTarget":instruction.is_jump_target,
        "isJump":is_jump,
        "conditional":conditional,
        "target":instruction.argval if is_jump else None,
        "terminal":terminal,
        "return":terminal and opname.startswith("RETURN"),
    }

def code_record(code,qualified_name):
    bytecode=dis.Bytecode(code)
    exception_entries=[]
    for entry in getattr(bytecode,"exception_entries",()):
        exception_entries.append({
            "start":entry.start,
            "end":entry.end,
            "target":entry.target,
            "depth":entry.depth,
            "lasti":entry.lasti,
        })
    record={
        "name":qualified_name,
        "filename":code.co_filename,
        "firstLine":code.co_firstlineno,
        "instructions":[instruction_record(item) for item in bytecode],
        "exceptions":exception_entries,
    }
    records=[record]
    for constant in code.co_consts:
        if isinstance(constant,types.CodeType):
            child_name=getattr(constant,"co_qualname",None) or (qualified_name+"."+constant.co_name)
            records.extend(code_record(constant,child_name))
    return records

print(json.dumps({"codeObjects":code_record(root,"<module>")},separators=(",",":")))
`.trim();

export const pythonControlFlowGraphProducer: ArtifactProducer = artifactProducer(
	'control-flow-graph',
	{
		output: 'stdout',
		arguments: () => ['-I', '-c', pythonCfgHelper],
	},
);

interface PythonInstruction {
	readonly offset: number;
	readonly opname: string;
	readonly argrepr: string;
	readonly startsLine?: number;
	readonly line?: number;
	readonly endLine?: number;
	readonly column?: number;
	readonly endColumn?: number;
	readonly isJumpTarget: boolean;
	readonly isJump: boolean;
	readonly conditional: boolean;
	readonly target?: number;
	readonly terminal: boolean;
	readonly return: boolean;
}

interface PythonExceptionEntry {
	readonly start: number;
	readonly end: number;
	readonly target: number;
	readonly depth: number;
	readonly lasti: boolean;
}

interface PythonCodeObject {
	readonly name: string;
	readonly filename: string;
	readonly firstLine: number;
	readonly instructions: readonly PythonInstruction[];
	readonly exceptions: readonly PythonExceptionEntry[];
}

export function parsePythonControlFlowGraphs(
	text: string,
	workingDirectory: string,
): GraphParseResult {
	let payload: unknown;
	try {
		payload = JSON.parse(text);
	} catch {
		return { graphs: [], diagnostics: ['Python emitted malformed control-flow JSON.'] };
	}
	if (!isRecord(payload) || !Array.isArray(payload.codeObjects)) {
		return { graphs: [], diagnostics: ['Python control-flow output has no code-object list.'] };
	}
	const graphs: ControlFlowGraph[] = [];
	const diagnostics: string[] = [];
	const graphIds = new GraphIdAllocator('python');
	for (const [index, candidate] of payload.codeObjects.entries()) {
		const code = parseCodeObject(candidate);
		if (!code) {
			diagnostics.push(`Omitted malformed Python code object ${index + 1}.`);
			continue;
		}
		const graph = codeObjectGraph(code, graphIds.allocate(code.name), workingDirectory, diagnostics);
		if (graph) {
			graphs.push(graph);
		}
	}
	return { graphs, diagnostics };
}

function codeObjectGraph(
	code: PythonCodeObject,
	id: string,
	workingDirectory: string,
	diagnostics: string[],
): ControlFlowGraph | undefined {
	if (code.instructions.length === 0) {
		return {
			id,
			label: code.name,
			nodes: [],
			edges: [],
		};
	}
	const leaders = new Set<number>([code.instructions[0].offset]);
	const offsets = new Set(code.instructions.map(instruction => instruction.offset));
	let malformed = false;
	for (const [index, instruction] of code.instructions.entries()) {
		if (instruction.isJumpTarget) {
			leaders.add(instruction.offset);
		}
		if (instruction.isJump) {
			if (instruction.target !== undefined && offsets.has(instruction.target)) {
				leaders.add(instruction.target);
			} else {
				diagnostics.push(
					`Python code object ${JSON.stringify(code.name)} has unknown jump target ${instruction.target === undefined ? 'value' : `offset ${instruction.target}`} from instruction offset ${instruction.offset}.`,
				);
				malformed = true;
			}
		}
		if ((instruction.isJump || instruction.terminal) && code.instructions[index + 1]) {
			leaders.add(code.instructions[index + 1].offset);
		}
	}
	for (const entry of code.exceptions) {
		if (offsets.has(entry.target)) {
			leaders.add(entry.target);
		} else {
			diagnostics.push(
				`Python code object ${JSON.stringify(code.name)} has unknown exception target offset ${entry.target}.`,
			);
			malformed = true;
		}
		const start = firstInstructionAtOrAfter(code.instructions, entry.start);
		if (start) {
			leaders.add(start.offset);
		}
		const end = firstInstructionAtOrAfter(code.instructions, entry.end);
		if (end) {
			leaders.add(end.offset);
		}
	}

	const blocks: PythonInstruction[][] = [];
	let current: PythonInstruction[] = [];
	for (const instruction of code.instructions) {
		if (current.length > 0 && leaders.has(instruction.offset)) {
			blocks.push(current);
			current = [];
		}
		current.push(instruction);
	}
	if (current.length > 0) {
		blocks.push(current);
	}

	const blockForOffset = new Map<number, number>();
	blocks.forEach((block, blockIndex) => {
		for (const instruction of block) {
			blockForOffset.set(instruction.offset, blockIndex);
		}
	});
	const nodeId = (blockIndex: number): string => `offset:${blocks[blockIndex][0].offset}`;
	const nodes: ControlFlowNode[] = blocks.map((block, blockIndex) => {
		const last = block.at(-1)!;
		const source = blockSource(block, code.filename, workingDirectory);
		const terminal = last.terminal ? (last.return ? 'return' as const : 'throw' as const) : undefined;
		return {
			id: nodeId(blockIndex),
			label: block.map(formatInstruction).join('\n'),
			...(source ? { source } : {}),
			referencedArtifactLines: block.map(instruction => instruction.offset),
			...(terminal ? { terminal } : {}),
		};
	});
	const edges: ControlFlowEdge[] = [];
	const edgeKeys = new Set<string>();
	const addEdge = (edge: ControlFlowEdge): void => {
		const key = `${edge.from}\0${edge.to}\0${edge.kind}\0${edge.label ?? ''}`;
		if (!edgeKeys.has(key)) {
			edgeKeys.add(key);
			edges.push(edge);
		}
	};
	for (const [blockIndex, block] of blocks.entries()) {
		const last = block.at(-1)!;
		const next = blocks[blockIndex + 1];
		if (last.isJump && last.target !== undefined) {
			const target = blockForOffset.get(last.target);
			if (target !== undefined) {
				const targetKind = pythonJumpTargetKind(last.opname);
				addEdge({
					from: nodeId(blockIndex),
					to: nodeId(target),
					kind: last.conditional ? targetKind : 'unconditional',
					...(last.argrepr ? { label: last.argrepr } : {}),
				});
			}
			if (last.conditional && next) {
				addEdge({
					from: nodeId(blockIndex),
					to: nodeId(blockIndex + 1),
					kind: pythonJumpTargetKind(last.opname) === 'true' ? 'false' : 'true',
				});
			}
		} else if (!last.terminal && next) {
			addEdge({ from: nodeId(blockIndex), to: nodeId(blockIndex + 1), kind: 'fallthrough' });
		}
	}
	for (const entry of code.exceptions) {
		const target = blockForOffset.get(entry.target);
		if (target === undefined) {
			continue;
		}
		for (const [blockIndex, block] of blocks.entries()) {
			if (block.some(instruction => instruction.offset >= entry.start && instruction.offset < entry.end)) {
				addEdge({
					from: nodeId(blockIndex),
					to: nodeId(target),
					kind: 'exception',
					label: `depth ${entry.depth}${entry.lasti ? ', lasti' : ''}`,
				});
			}
		}
	}
	if (malformed) {
		diagnostics.push(`Python code object ${JSON.stringify(code.name)} was omitted because its control-flow structure is malformed.`);
		return undefined;
	}
	return {
		id,
		label: code.name,
		entryNodeId: nodes[0]?.id,
		nodes,
		edges,
	};
}

function blockSource(
	instructions: readonly PythonInstruction[],
	filename: string,
	workingDirectory: string,
): ControlFlowSourceLocation | undefined {
	const instruction = instructions.find(item => item.startsLine !== undefined || item.line !== undefined);
	const line = instruction?.startsLine ?? instruction?.line;
	if (!instruction || line === undefined || line < 1) {
		return undefined;
	}
	return {
		uri: compilerSourceUri(filename, workingDirectory),
		line: line - 1,
		column: Math.max(0, instruction.column ?? 0),
		endLine: instruction.endLine && instruction.endLine >= line
			? instruction.endLine - 1
			: undefined,
		endColumn: instruction.endColumn !== undefined
			? Math.max(0, instruction.endColumn)
			: undefined,
	};
}

function firstInstructionAtOrAfter(
	instructions: readonly PythonInstruction[],
	boundary: number,
): PythonInstruction | undefined {
	return instructions.find(instruction => instruction.offset >= boundary);
}






function parseCodeObject(value: unknown): PythonCodeObject | undefined {
	if (!isRecord(value)
		|| typeof value.name !== 'string'
		|| !value.name.trim()
		|| typeof value.filename !== 'string'
		|| optionalPositiveInteger(value.firstLine) === undefined
		|| !Array.isArray(value.instructions)
		|| !Array.isArray(value.exceptions)) {
		return undefined;
	}
	const instructions = value.instructions.map(parseInstruction);
	const exceptions = value.exceptions.map(parseExceptionEntry);
	if (instructions.some(item => !item) || exceptions.some(item => !item)) {
		return undefined;
	}
	const parsedInstructions = instructions as PythonInstruction[];
	if (parsedInstructions.some((instruction, index) =>
		instruction.offset < 0
		|| (index > 0 && instruction.offset <= parsedInstructions[index - 1].offset))) {
		return undefined;
	}
	return {
		name: value.name,
		filename: value.filename,
		firstLine: value.firstLine as number,
		instructions: parsedInstructions,
		exceptions: exceptions as PythonExceptionEntry[],
	};
}

function parseInstruction(value: unknown): PythonInstruction | undefined {
	if (!isRecord(value)
		|| integer(value.offset) === undefined
		|| typeof value.opname !== 'string'
		|| typeof value.argrepr !== 'string'
		|| typeof value.isJumpTarget !== 'boolean'
		|| typeof value.isJump !== 'boolean'
		|| typeof value.conditional !== 'boolean'
		|| typeof value.terminal !== 'boolean'
		|| typeof value.return !== 'boolean'
		|| !isOptionalPositiveInteger(value.startsLine)
		|| !isOptionalPositiveInteger(value.line)
		|| !isOptionalPositiveInteger(value.endLine)
		|| !isOptionalNonnegativeInteger(value.column)
		|| !isOptionalNonnegativeInteger(value.endColumn)
		|| !isOptionalNonnegativeInteger(value.target)) {
		return undefined;
	}
	const startsLine = optionalPositiveInteger(value.startsLine);
	const line = optionalPositiveInteger(value.line);
	const endLine = optionalPositiveInteger(value.endLine);
	const column = optionalNonnegativeInteger(value.column);
	const endColumn = optionalNonnegativeInteger(value.endColumn);
	const target = optionalNonnegativeInteger(value.target);
	return {
		offset: value.offset as number,
		opname: value.opname,
		argrepr: value.argrepr,
		...(startsLine === undefined ? {} : { startsLine }),
		...(line === undefined ? {} : { line }),
		...(endLine === undefined ? {} : { endLine }),
		...(column === undefined ? {} : { column }),
		...(endColumn === undefined ? {} : { endColumn }),
		isJumpTarget: value.isJumpTarget,
		isJump: value.isJump,
		conditional: value.conditional,
		...(target === undefined ? {} : { target }),
		terminal: value.terminal,
		return: value.return,
	};
}

function parseExceptionEntry(value: unknown): PythonExceptionEntry | undefined {
	if (!isRecord(value)
		|| optionalNonnegativeInteger(value.start) === undefined
		|| optionalNonnegativeInteger(value.end) === undefined
		|| optionalNonnegativeInteger(value.target) === undefined
		|| optionalNonnegativeInteger(value.depth) === undefined
		|| (value.end as number) < (value.start as number)
		|| typeof value.lasti !== 'boolean') {
		return undefined;
	}
	return {
		start: value.start as number,
		end: value.end as number,
		target: value.target as number,
		depth: value.depth as number,
		lasti: value.lasti,
	};
}

function formatInstruction(instruction: PythonInstruction): string {
	return `${String(instruction.offset).padStart(4)}  ${instruction.opname}${instruction.argrepr ? `  ${instruction.argrepr}` : ''}`;
}

/** Python names false-taking branches explicitly; loop/send targets are their exhausted path. */
function pythonJumpTargetKind(opname: string): 'true' | 'false' {
	return opname.includes('IF') && !opname.includes('FALSE') ? 'true' : 'false';
}


function optionalPositiveInteger(value: unknown): number | undefined {
	return value === null || value === undefined
		? undefined
		: integer(value) !== undefined && (value as number) > 0
			? value as number
			: undefined;
}

function optionalNonnegativeInteger(value: unknown): number | undefined {
	return value === null || value === undefined
		? undefined
		: integer(value) !== undefined && (value as number) >= 0
			? value as number
			: undefined;
}

function isOptionalPositiveInteger(value: unknown): boolean {
	return value === null || value === undefined || optionalPositiveInteger(value) !== undefined;
}

function isOptionalNonnegativeInteger(value: unknown): boolean {
	return value === null || value === undefined || optionalNonnegativeInteger(value) !== undefined;
}

function integer(value: unknown): number | undefined {
	return Number.isSafeInteger(value) ? value as number : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
