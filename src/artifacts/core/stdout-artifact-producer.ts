import type { ArtifactProducer } from '../../toolchains/toolchain-map.js';
import type { StdoutArtifactSpec } from '../../toolchains/toolchain-backend.js';
import type { ArtifactKind } from '../../types/index.js';

export function stdoutArtifactProducer(
	kind: ArtifactKind,
	spec: StdoutArtifactSpec,
): ArtifactProducer {
	return (backend, source, options, cancellationToken) =>
		backend.produceStdoutArtifact(kind, source, options, spec, cancellationToken);
}
