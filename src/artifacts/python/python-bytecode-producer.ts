import type { ArtifactProducer } from '../../toolchains/toolchain-map.js';
import { artifactProducer } from '../core/compiler-output-producer.js';

export const pythonBytecodeProducer: ArtifactProducer = artifactProducer('python-bytecode', {
	output: 'stdout',
	arguments: () => ['-m', 'dis'],
});
