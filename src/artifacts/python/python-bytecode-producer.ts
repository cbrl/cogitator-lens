import { outputProducer } from '../core/compiler-output-producer.js';

export const pythonBytecodeProducer = outputProducer({
	output: 'stdout',
	arguments: () => ['-m', 'dis'],
});
