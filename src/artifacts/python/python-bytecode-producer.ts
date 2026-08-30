import type { ArtifactProducer } from '../../toolchains/toolchain-map.js';
import { stdoutArtifactProducer } from '../core/stdout-artifact-producer.js';

export const pythonBytecodeProducer: ArtifactProducer = stdoutArtifactProducer(
	'python-bytecode',
	{
		arguments: () => ['-m', 'dis'],
	},
);
