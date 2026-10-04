import type { Uri } from 'vscode';
import {
	ToolchainBackend,
	type ArtifactOutputSpec,
	type ToolchainHost,
} from '../../src/toolchains/toolchain-backend.js';
import { toolchainDefinitions } from '../../src/toolchains/toolchain-map.js';
import { resolveArtifactAvailability, resolveArtifactOutput } from '../../src/toolchains/toolchain-artifacts.js';
import type {
	ArtifactProducer,
	ToolchainArtifactCell,
	ToolchainArtifactOutput,
} from '../../src/toolchains/toolchain-contracts.js';
import {
	defaultArtifactOptions,
	type ArtifactKind,
	type AuxiliaryTool,
	type ProductionOptions,
	type RawArtifact,
	type ToolchainKind,
	type ToolchainProfile,
} from '../../src/types/index.js';
import { rawArtifact } from './artifacts.js';

/** A host that suppresses backend logging during tests. */
export const testToolchainHost: ToolchainHost = {
	log() {},
};

/** A cancellation token that is never signalled. */
export const neverCancelled = {
	isCancellationRequested: false,
	onCancellationRequested: () => ({ dispose: () => undefined }),
} as never;

/** A configured toolchain that runs the current Node binary unless told otherwise. */
type ToolchainProfileOverrides = Omit<Partial<ToolchainProfile>, 'tools'> & {
	readonly tools?: Readonly<Record<string, AuxiliaryTool>>;
};

export function toolchainProfile(kind: ToolchainKind, overrides: ToolchainProfileOverrides = {}): ToolchainProfile {
	return {
		id: `test:${kind}`,
		displayName: `Test ${kind}`,
		kind,
		executable: process.execPath,
		defaultArguments: [],
		environment: {},
		...overrides,
		tools: overrides.tools ?? {},
	};
}

export function toolchainBackend(kind: ToolchainKind, overrides: ToolchainProfileOverrides = {}): ToolchainBackend {
	return new ToolchainBackend(toolchainProfile(kind, overrides), toolchainDefinitions[kind], testToolchainHost);
}

/**
 * Builds a `Uri` shaped value for the fields renderers and parsers read.
 *
 * The path is kept verbatim so a test can decide whether it is talking about a
 * POSIX path, a Windows path, or a host-resolved one.
 */
export function sourceUri(filename: string): Uri {
	const posix = filename.replaceAll('\\', '/');
	return {
		scheme: 'file',
		fsPath: filename,
		path: posix,
		toString: () => `file:///${encodeURI(posix.replace(/^\/+/u, ''))}`,
	} as never;
}

export function artifactAvailability(toolchain: ToolchainKind, artifact: ArtifactKind): string {
	return resolveArtifactAvailability(toolchainProfile(toolchain), artifact).status;
}

/** The artifact cell a toolchain declares, asserted to own a producer of its own. */
export function availableCell(
	toolchain: ToolchainKind,
	artifact: ArtifactKind,
): { readonly producer: ArtifactProducer } {
	const cell: ToolchainArtifactCell = toolchainDefinitions[toolchain].artifacts[artifact];
	if (cell.status !== 'available' || !('producer' in cell)) {
		throw new Error(`${toolchain} declares no ${artifact} producer.`);
	}
	return cell;
}

/** One named compiler output of an artifact, asserted to be selectable. */
export function availableOutput(
	toolchain: ToolchainKind,
	artifact: ArtifactKind,
	outputId: string,
): ToolchainArtifactOutput {
	const output = resolveArtifactOutput(toolchainProfile(toolchain), artifact, outputId);
	if (output.status !== 'available' || output.id === undefined) {
		throw new Error(`${toolchain} declares no ${outputId} output for ${artifact}.`);
	}
	return output as ToolchainArtifactOutput;
}

export interface RecordedProduction {
	readonly kind: ArtifactKind;
	readonly spec: ArtifactOutputSpec;
	readonly output: ArtifactOutputSpec['output'];
	readonly outputFilename: string | undefined;
	readonly arguments: readonly string[];
	/** True when the producer delegated to the shared assembly path instead of a spec. */
	readonly viaAssembly: boolean;
}

/**
 * Runs a producer against a backend that records rather than executes.
 *
 * Every producer routes through `produceArtifact` with an output specification,
 * or through `produceAssembly` when it reuses the assembly path, so recording
 * both calls captures what the producer owns without spawning a compiler.
 */
export async function recordProduction(
	producer: ArtifactProducer,
	options: {
		readonly outputFile?: string;
		readonly temporaryDirectory?: string;
		readonly providerArguments?: readonly string[];
		readonly productionOptions?: ProductionOptions;
		readonly profileKind?: ToolchainKind;
	} = {},
): Promise<RecordedProduction> {
	let recorded: Omit<RecordedProduction, 'viaAssembly'> | undefined;
	let viaAssembly = false;
	const backend = {
		profile: options.profileKind ? toolchainProfile(options.profileKind) : undefined,
		produceArtifact: async (kind: ArtifactKind, _source: unknown, _options: unknown, spec: ArtifactOutputSpec) => {
			recorded = {
				kind,
				spec,
				output: spec.output,
				outputFilename: spec.output === 'stdout' || spec.output === 'stderr' ? undefined : spec.output.filename,
				arguments: spec.arguments(
					options.outputFile ?? '',
					options.temporaryDirectory ?? '/temporary',
					options.providerArguments ?? [],
				),
			};
			return rawArtifact(kind, '');
		},
		produceAssembly: async () => {
			viaAssembly = true;
			return rawArtifact('assembly', '');
		},
	};

	const raw = await producer(
		backend as never,
		{} as never,
		{ productionOptions: options.productionOptions ?? defaultArtifactOptions.production },
		neverCancelled,
	);
	if (recorded === undefined) {
		if (!viaAssembly) {
			throw new Error('The producer requested neither an artifact nor assembly.');
		}
		return {
			kind: raw.kind,
			spec: { output: 'stdout', arguments: () => [] },
			output: 'stdout',
			outputFilename: undefined,
			arguments: [],
			viaAssembly,
		};
	}
	return { ...recorded, viaAssembly };
}
