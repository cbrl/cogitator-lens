import type { Uri } from 'vscode';
import type {
	CompileDiagnostic,
	ControlFlowGraph,
	DisplayOptions,
	RawArtifact,
	RenderedGraphArtifact,
} from '../../types/index.js';
import { invocationDetails } from '../../types/index.js';
import type { ArtifactRenderContext } from '../core/artifact-definitions.js';
import type { AssemblyCfgParser } from './cfg/assembly-cfg-parser.js';
import { toAssemblyLines } from './cfg/assembly-line.js';
import {
	ClangAssemblyCfgParser,
	GccAssemblyCfgParser,
	MsvcAssemblyCfgParser,
} from './cfg/assembly-dialects.js';
import { InstructionSetInfo } from './cfg/instruction-sets.js';
import { parseLlvmControlFlowGraphs } from './cfg/llvm-ir-cfg-parser.js';
import {
	controlFlowGraphMetrics,
	validateControlFlowGraphs,
	type GraphParseResult,
} from './control-flow-graph-model.js';
import { parseGccControlFlowGraphs } from './gcc-cfg-parser.js';
import { parsePythonControlFlowGraphs } from '../control-flow-graph/python-cfg.js';
import { parseRustMirControlFlowGraphs } from '../rust/rust-mir-cfg-parser.js';

export function renderControlFlowGraphArtifact(
	raw: RawArtifact,
	options: DisplayOptions,
	context: ArtifactRenderContext,
): RenderedGraphArtifact {
	const parsed = remapRemoteSources(parseControlFlowGraphs(raw, options, context), context.source.uri);
	const validated = validateControlFlowGraphs(parsed.graphs);
	const messages = [...parsed.diagnostics, ...validated.diagnostics];
	const diagnostics: CompileDiagnostic[] = [
		...raw.diagnostics,
		...messages.map(message => ({
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
		command: invocationDetails(raw.command),
		metrics: controlFlowGraphMetrics(validated.graphs),
		truncated: raw.truncated,
		toolOutputTruncated: raw.truncated,
	};
}

function parseControlFlowGraphs(
	raw: RawArtifact,
	options: DisplayOptions,
	context: ArtifactRenderContext,
): GraphParseResult {
	const workingDirectory = raw.command.workingDirectory;
	switch (context.artifactOutputId) {
		case 'assembly':
			return parseAssemblyControlFlowGraphs(
				assemblyParser(context.backend.profile.kind),
				raw,
				options,
				context,
			);
		case 'gcc-tree':
			return parseGccControlFlowGraphs(raw.text, workingDirectory);
		case 'llvm-ir':
			return parseLlvmControlFlowGraphs(raw.text, workingDirectory);
		case 'rust-mir':
			return parseRustMirControlFlowGraphs(raw.text, workingDirectory);
		case 'python-bytecode':
			return parsePythonControlFlowGraphs(raw.text, workingDirectory);
		case undefined:
			throw new Error('A control-flow graph output must be selected.');
		default:
			throw new Error(`Unknown control-flow graph output: ${context.artifactOutputId}`);
	}
}

function assemblyParser(kind: ArtifactRenderContext['backend']['profile']['kind']): AssemblyCfgParser {
	switch (kind) {
		case 'gcc':
			return new GccAssemblyCfgParser(new InstructionSetInfo());
		case 'clang':
		case 'apple-clang':
		case 'clang-cl':
		case 'rust':
			return new ClangAssemblyCfgParser(new InstructionSetInfo());
		case 'msvc':
			return new MsvcAssemblyCfgParser();
		case 'python':
			throw new Error('Python has no assembly control-flow graph output.');
	}
}

/**
 * Runs an assembly listing through the toolchain's own assembly parser before
 * building a graph, so blocks inherit the source attribution the parser
 * recovered from the listing's debug annotations.
 */
function parseAssemblyControlFlowGraphs(
	parser: AssemblyCfgParser,
	raw: RawArtifact,
	options: DisplayOptions,
	context: ArtifactRenderContext,
): GraphParseResult {
	const parsedAssembly = context.backend.parseAssembly(raw.text, options);
	const lines = toAssemblyLines(
		parsedAssembly.asm,
		context.source.uri.toString(),
		raw.command.workingDirectory,
	);
	return parser.parse(lines);
}

/** Preserve the source document's remote authority for compiler-emitted paths. */
function remapRemoteSources(parsed: GraphParseResult, workspaceSource: Uri): GraphParseResult {
	if (workspaceSource.scheme !== 'vscode-remote') {
		return parsed;
	}
	return {
		...parsed,
		graphs: parsed.graphs.map(graph => ({
			...graph,
			nodes: graph.nodes.map(node => {
				const remapped = node.source && remapRemoteUri(node.source.uri, workspaceSource);
				return remapped
					? { ...node, source: { ...node.source!, uri: remapped } }
					: node;
			}),
		} satisfies ControlFlowGraph)),
	};
}

function remapRemoteUri(uri: string, workspaceSource: Uri): string | undefined {
	try {
		const source = new URL(uri);
		return source.protocol === 'file:'
			? workspaceSource.with({
				path: decodeURIComponent(source.pathname),
				query: '',
				fragment: '',
			}).toString()
			: undefined;
	} catch {
		return undefined;
	}
}
