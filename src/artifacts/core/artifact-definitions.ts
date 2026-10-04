import { assemblyArtifact } from '../assembly/index.js';
import { astArtifact } from '../ast/index.js';
import { binaryDisassemblyArtifact } from '../binary-disassembly/index.js';
import { controlFlowGraphArtifact } from '../control-flow-graph/index.js';
import { llvmIrArtifact } from '../llvm-ir/index.js';
import { optimizationRemarksArtifact } from '../optimization-remarks/index.js';
import { preprocessedSourceArtifact } from '../preprocessed-source/index.js';
import { rustMirArtifact } from '../rust/index.js';
import { stackAnalysisArtifact } from '../stack-analysis/index.js';
import type { ArtifactDefinition, ArtifactKind, ArtifactOptionDescriptor } from './artifact-contracts.js';

export type {
	ArtifactDefinition,
	ArtifactKind,
	ArtifactListingSyntax,
	ArtifactOptionAvailability,
	ArtifactOptionDescriptor,
	ArtifactRenderContext,
	ArtifactRenderer,
} from './artifact-contracts.js';

const artifactDefinitionTable = {
	assembly: assemblyArtifact,
	'binary-disassembly': binaryDisassemblyArtifact,
	'preprocessed-source': preprocessedSourceArtifact,
	ast: astArtifact,
	'llvm-ir': llvmIrArtifact,
	'rust-mir': rustMirArtifact,
	'optimization-remarks': optimizationRemarksArtifact,
	'stack-analysis': stackAnalysisArtifact,
	'control-flow-graph': controlFlowGraphArtifact,
} as const satisfies Record<ArtifactKind, ArtifactDefinition>;

export const artifactDefinitions: typeof artifactDefinitionTable & Record<ArtifactKind, ArtifactDefinition> =
	artifactDefinitionTable;

export const supportedArtifactKinds = Object.freeze(Object.keys(artifactDefinitions) as ArtifactKind[]);

/** Artifact kind used when a source-focused UI has no artifact identity. */
export const defaultArtifactKind = 'assembly' satisfies ArtifactKind;

export function getArtifactKind(value: string): ArtifactKind | undefined {
	return Object.hasOwn(artifactDefinitions, value) ? (value as ArtifactKind) : undefined;
}

export function artifactSupportsOption(kind: ArtifactKind, optionId: ArtifactOptionDescriptor['id']): boolean {
	const definition = artifactDefinitions[kind];
	return definition.options.some((option) => option.id === optionId);
}
