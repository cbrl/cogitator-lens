import type { Uri } from 'vscode';
import type {
	CompileDiagnostic,
	ControlFlowGraph,
	DisplayOptions,
	RawArtifact,
	RenderedGraphArtifact,
} from '../../types/index.js';
import type { ArtifactRenderContext } from '../core/artifact-contracts.js';
import {
	controlFlowGraphMetrics,
	validateControlFlowGraphs,
	type GraphParseResult,
} from './control-flow-graph-model.js';

export function renderControlFlowGraphArtifact(
	raw: RawArtifact,
	options: DisplayOptions,
	context: ArtifactRenderContext,
): RenderedGraphArtifact {
	const parsed = remapRemoteSources(context.artifactOutput!.parseGraphs!(raw, options, context), context.source.uri);
	const validated = validateControlFlowGraphs(parsed.graphs);
	const messages = [...parsed.diagnostics, ...validated.diagnostics];
	const diagnostics: CompileDiagnostic[] = [
		...raw.diagnostics,
		...messages.map((message) => ({
			uri: context.source.uri,
			line: 0,
			column: 0,
			severity: 'information' as const,
			message,
		})),
	];
	return {
		kind: raw.kind,
		presentation: 'graph',
		graphs: validated.graphs,
		diagnostics,
		durationMs: raw.durationMs,
		generatedAt: raw.generatedAt,
		command: raw.command,
		metrics: controlFlowGraphMetrics(validated.graphs),
		truncated: false,
	};
}

/** Preserve the source document's remote authority for compiler-emitted paths. */
function remapRemoteSources(parsed: GraphParseResult, workspaceSource: Uri): GraphParseResult {
	if (workspaceSource.scheme !== 'vscode-remote') {
		return parsed;
	}
	return {
		...parsed,
		graphs: parsed.graphs.map(
			(graph) =>
				({
					...graph,
					nodes: graph.nodes.map((node) => {
						const remapped = node.source && remapRemoteUri(node.source.uri, workspaceSource);
						return remapped ? { ...node, source: { ...node.source!, uri: remapped } } : node;
					}),
				}) satisfies ControlFlowGraph,
		),
	};
}

function remapRemoteUri(uri: string, workspaceSource: Uri): string | undefined {
	try {
		const source = new URL(uri);
		return source.protocol === 'file:'
			? workspaceSource
					.with({
						path: decodeURIComponent(source.pathname),
						query: '',
						fragment: '',
					})
					.toString()
			: undefined;
	} catch {
		return undefined;
	}
}
