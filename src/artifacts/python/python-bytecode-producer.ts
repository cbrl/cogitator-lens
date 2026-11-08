import { outputProducer } from '../core/compiler-output-producer.js';

/**
 * Compiles the source and prints its bytecode, as `python -m dis <file>` does. Python 3.13 gives
 * the same output both ways, except for the addresses of the code objects. A second argument names
 * a file with unsaved text, which compiles with the name of the source.
 */
export const pythonDisassemblyHelper = [
	'import dis,sys',
	'name=sys.argv[1]',
	'with open(sys.argv[2] if len(sys.argv)>2 else name,"rb") as source_file:',
	'    source=source_file.read()',
	'dis.dis(compile(source,name,"exec"))',
].join('\n');

export const pythonBytecodeProducer = outputProducer({
	output: 'stdout',
	// Isolated mode keeps a local dis.py or opcode.py out of the import path.
	arguments: () => ['-I', '-c', pythonDisassemblyHelper],
});
