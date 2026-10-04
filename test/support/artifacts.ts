import path from 'node:path';
import type { ToolchainBackend } from '../../src/toolchains/toolchain-backend.js';
import type {
	ArtifactKind,
	ArtifactListingSyntax,
	ArtifactRenderContext,
	RawArtifact,
	RenderedArtifactLine,
	RenderedGraphArtifact,
	RenderedTextArtifact,
	ToolchainKind,
} from '../../src/types/index.js';
import { defaultArtifactOptions } from '../../src/types/index.js';
import type { ArtifactImplementation } from '../../src/toolchains/toolchain-contracts.js';
import { artifactDefinitions } from '../../src/artifacts/core/artifact-definitions.js';
import { sourceUri, toolchainBackend } from './toolchains.js';

/** Tool output as the compilation layer hands it to a renderer. */
export function rawArtifact(kind: ArtifactKind, text: string, overrides: Partial<RawArtifact> = {}): RawArtifact {
	return {
		kind,
		text,
		diagnostics: [],
		durationMs: 1,
		generatedAt: 0,
		command: {
			executable: process.execPath,
			args: [],
			environmentVariableNames: [],
			cwd: path.resolve('/project'),
		},
		inputs: [],
		dependencyCoverage: 'source-only',
		...overrides,
	};
}

/**
 * The context a renderer reads: the toolchain that produced the artifact and
 * the source the artifact is mapped back onto.
 */
export function renderContext(
	toolchain: ToolchainKind | ToolchainBackend,
	source: { readonly file?: string; readonly text?: string } = {},
): ArtifactRenderContext {
	return {
		backend: typeof toolchain === 'string' ? toolchainBackend(toolchain) : toolchain,
		source: {
			uri: sourceUri(source.file ?? path.resolve('/project/source.cpp')),
			text: source.text ?? '',
		},
	};
}

/** A rendered text artifact carrying only the lines a test cares about. */
export function textArtifact(
	kind: ArtifactKind,
	lines: readonly RenderedArtifactLine[],
	listingSyntax: ArtifactListingSyntax | undefined = artifactDefinitions[kind].listingSyntax,
): RenderedTextArtifact {
	return {
		kind,
		...(listingSyntax ? { listingSyntax } : {}),
		presentation: 'text',
		diagnostics: [],
		durationMs: 0,
		generatedAt: 0,
		command: { executable: '', args: [], environmentVariableNames: [], cwd: '' },
		metrics: {},
		truncated: false,
		lines,
		links: [],
		folds: [],
		symbols: [],
	};
}

/** Renders raw output with the renderer of a control-flow-graph output and expects graphs. */
export async function renderGraphs(
	output: ArtifactImplementation,
	raw: RawArtifact,
	context: ArtifactRenderContext,
): Promise<RenderedGraphArtifact> {
	const rendered = await output.renderer?.(raw, defaultArtifactOptions.display, context);
	if (rendered?.presentation !== 'graph') {
		throw new Error('The output did not render a graph.');
	}
	return rendered;
}
