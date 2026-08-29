import type { ArtifactProducer } from '../../toolchains/toolchain-map.js';
import { stdoutArtifactProducer } from '../compiler/front-end-producers.js';

export const pythonBytecodeProducer: ArtifactProducer = stdoutArtifactProducer(
	'python-bytecode',
	{
		arguments: () => ['-m', 'dis'],
	},
);
