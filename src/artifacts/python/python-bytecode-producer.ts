import { outputProducer } from '../core/compiler-output-producer.js';

export const pythonBytecodeProducer = outputProducer({
	output: 'stdout',
	// Isolated mode keeps a local dis.py or opcode.py out of the import path.
	arguments: () => ['-I', '-m', 'dis'],
});
