import type { ArtifactProducer } from '../../toolchains/toolchain-map.js';
import { artifactProducer } from '../core/compiler-output-producer.js';

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

export const pythonControlFlowGraphProducer: ArtifactProducer = artifactProducer('control-flow-graph', {
	output: 'stdout',
	arguments: () => ['-I', '-c', pythonCfgHelper],
});
