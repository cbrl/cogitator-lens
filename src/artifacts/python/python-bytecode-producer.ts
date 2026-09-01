import type { ArtifactProducer } from '../../toolchains/toolchain-map.js';
import { artifactProducer } from '../core/compiler-output-producer.js';

const producePythonBytecode = artifactProducer('assembly', {
	output: 'stdout',
	arguments: () => ['-m', 'dis'],
});

export const pythonBytecodeProducer: ArtifactProducer = async (...arguments_) => ({
	...(await producePythonBytecode(...arguments_)),
	artifactDialect: 'python-bytecode',
});
