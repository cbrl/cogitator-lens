import path from 'node:path';
import type { ToolchainBackend } from '../../src/toolchains/toolchain-backend.js';
import type {
	ArtifactKind,
	ArtifactRenderContext,
	RawArtifact,
	RenderedArtifactLine,
	RenderedTextArtifact,
	ToolchainKind,
} from '../../src/types/index.js';
import type { ToolchainArtifactOutput } from '../../src/toolchains/toolchain-map.js';
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
			arguments: [],
			environmentVariableNames: [],
			workingDirectory: path.resolve('/project'),
		},
		truncated: false,
		inputs: [],
		dependencyCoverage: 'source-only',
		...overrides,
	};
}

/**
 * The context a renderer reads: the toolchain that produced the artifact, the
 * selected compiler output, and the source the artifact is mapped back onto.
 */
export function renderContext(
	toolchain: ToolchainKind | ToolchainBackend,
	source: { readonly file?: string; readonly text?: string } = {},
	artifactOutput?: ToolchainArtifactOutput,
): ArtifactRenderContext {
	return {
		backend: typeof toolchain === 'string' ? toolchainBackend(toolchain) : toolchain,
		...(artifactOutput ? { artifactOutput } : {}),
		source: {
			uri: sourceUri(source.file ?? path.resolve('/project/source.cpp')),
			text: source.text ?? '',
		},
	};
}

/** A rendered text artifact carrying only the lines a test cares about. */
export function textArtifact(kind: ArtifactKind, lines: readonly RenderedArtifactLine[]): RenderedTextArtifact {
	const text = lines.map((line) => line.text).join('\n');
	return {
		kind,
		presentation: 'text',
		diagnostics: [],
		durationMs: 0,
		generatedAt: 0,
		command: { executable: '', args: [], environmentVariableNames: [], cwd: '' },
		metrics: {},
		truncated: false,
		toolOutputTruncated: false,
		lines,
		sourceLocations: [],
		links: [],
		folds: [],
		symbols: [],
		raw: text,
		text,
	};
}
