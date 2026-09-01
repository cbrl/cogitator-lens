import { artifactProducer } from '../core/compiler-output-producer.js';

export const pythonBytecodeProducer = artifactProducer('assembly', {
	output: 'stdout',
	arguments: () => ['-m', 'dis'],
});
