import type { ArtifactProducer } from '../toolchains/toolchain-map.js';

export const pythonBytecodeProducer: ArtifactProducer = (
	backend,
	source,
	options,
	cancellationToken,
) => backend.produceStdoutArtifact(
	'python-bytecode',
	source,
	options,
	['-m', 'dis'],
	cancellationToken,
);
