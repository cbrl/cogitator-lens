import type { RawArtifact } from '../../types/index.js';
import type { DotNetSourceMapping } from '../../vendor/lib/parsers/pdb-parser-dotnet.js';

declare const dotNetSourceMappingBrand: unique symbol;

/** Branded producer data that keeps .NET PDB mappings out of the generic artifact model. */
export interface DotNetSourceMappingData {
	readonly kind: 'dotnet-source-mapping';
	readonly sourceMapping: DotNetSourceMapping;
	readonly [dotNetSourceMappingBrand]: true;
}

/** Wraps a PDB source mapping for storage in \`RawArtifact.producerData\`. */
export function dotNetSourceMappingData(sourceMapping: DotNetSourceMapping): DotNetSourceMappingData {
	return { kind: 'dotnet-source-mapping', sourceMapping } as DotNetSourceMappingData;
}

/** Safely retrieves this module's PDB mapping from generic producer data. */
export function dotNetSourceMappingFor(raw: RawArtifact): DotNetSourceMapping | undefined {
	const data = raw.producerData;
	return isDotNetSourceMappingData(data) ? data.sourceMapping : undefined;
}

/** Narrows untrusted producer data before exposing it to the IL renderer. */
function isDotNetSourceMappingData(value: unknown): value is DotNetSourceMappingData {
	return typeof value === 'object' && value !== null &&
		(value as { kind?: unknown }).kind === 'dotnet-source-mapping' &&
		Array.isArray((value as { sourceMapping?: unknown }).sourceMapping);
}
