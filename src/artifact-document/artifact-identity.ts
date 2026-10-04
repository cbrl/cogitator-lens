import type { ArtifactKind } from '../types/index.js';
import type { ArtifactStatus } from './artifact-generator.js';

export interface ArtifactDocumentIdentity {
	readonly documentUri: string;
	readonly sourceUri: string;
	readonly sourceLabel: string;
	readonly artifactKind: ArtifactKind;
	readonly artifactLabel: string;
	readonly artifactOutputId?: string;
	readonly presetId: string;
	readonly variantId: string;
	readonly variantLabel: string;
	readonly toolchainId: string;
	readonly toolchainLabel: string;
	readonly toolchainKind: string;
}

export interface ArtifactDocumentSnapshot {
	readonly identity: ArtifactDocumentIdentity;
	readonly status: ArtifactStatus;
}
