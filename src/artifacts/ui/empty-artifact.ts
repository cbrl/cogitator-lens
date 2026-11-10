import path from 'node:path';
import type { ArtifactDocumentIdentity } from '../../artifact-document/artifact-identity.js';
import type { ArtifactKind, RenderedTextArtifact } from '../../types/index.js';
import { artifactDefinitions } from '../core/artifact-definitions.js';
import { filteredLineCountMetric } from '../core/rendered-artifact.js';

/** Artifact kinds that list generated code. */
const codeKinds: ReadonlySet<ArtifactKind> = new Set(['assembly', 'binary-disassembly', 'llvm-ir', 'rust-mir']);

const cFamilyToolchains: ReadonlySet<string> = new Set([
	'gcc',
	'clang',
	'apple-clang',
	'clang-cl',
	'msvc',
	'nvcc',
	'zig',
]);

/**
 * Explains a listing that has no text. An empty editor looks like a failure, so the text names the
 * likely causes for the toolchain and the artifact kind.
 */
export function emptyArtifactText(
	artifact: Pick<RenderedTextArtifact, 'kind' | 'metrics'>,
	identity: Pick<ArtifactDocumentIdentity, 'sourceLabel' | 'toolchainKind'>,
): string {
	const definition = artifactDefinitions[artifact.kind];
	const source = path.basename(identity.sourceLabel);
	const lines = [emptyStatement(artifact.kind, definition.label, source)];

	const filtered = artifact.metrics[filteredLineCountMetric];
	if (typeof filtered === 'number' && filtered > 0) {
		lines.push(
			`The display options removed all ${filtered} ${filtered === 1 ? 'line' : 'lines'} of the output. ` +
				`Change the ${definition.label} options to show them.`,
		);
	}

	const causes = likelyCauses(artifact.kind, identity.toolchainKind);
	if (causes.length > 0) {
		lines.push('', 'Possible causes:', ...causes.map((cause) => `- ${cause}`));
	}
	return lines.join('\n');
}

function emptyStatement(kind: ArtifactKind, label: string, source: string): string {
	switch (kind) {
		case 'optimization-remarks':
			return `The compiler reported no optimization remarks for ${source}.`;
		case 'stack-analysis':
			return `The compiler reported no stack usage for ${source}.`;
		default:
			return `The compiler made no ${label} output for ${source}.`;
	}
}

const rustCodeCauses = [
	'A private function that nothing calls is not compiled. Make it pub, or call it from main.',
	'With optimization, a small pub function of a library crate is not compiled either, because each crate that calls it compiles its own copy. Add #[inline(never)] to it.',
	'A generic function makes no code until code uses it with a type.',
];

/** A compile without optimization gives few remarks or none. */
function remarkCauses(toolchainKind: string): string[] {
	const level = 'Set Optimization Level in the status menu selects a level, such as';
	switch (toolchainKind) {
		case 'msvc':
			return [`cl.exe reports only on loops, and only when it optimizes. ${level} /O2.`];
		case 'go':
			return [];
		case 'rust':
		case 'cargo':
			return [`The compile does not optimize. ${level} -C opt-level=2.`, ...rustCodeCauses];
		default:
			return [`The compile does not optimize. ${level} -O2.`];
	}
}

function likelyCauses(kind: ArtifactKind, toolchainKind: string): string[] {
	if (kind === 'optimization-remarks') {
		return remarkCauses(toolchainKind);
	}
	if (!codeKinds.has(kind) && kind !== 'stack-analysis') {
		return [];
	}
	const libraryCode = artifactDefinitions[kind].options.some((option) => option.id === 'showLibraryCode')
		? ['"Show library code" is off, and all of the code comes from headers or libraries.']
		: [];
	if (cFamilyToolchains.has(toolchainKind)) {
		return [
			'A function that is static or inline, and that nothing uses, is not compiled.',
			'A template makes no code until code uses it with a type.',
			...libraryCode,
		];
	}
	switch (toolchainKind) {
		case 'rust':
		case 'cargo':
			return [...rustCodeCauses, ...libraryCode];
		case 'go':
			return ['A function that nothing calls can be removed, or inlined into its callers.', ...libraryCode];
		default:
			return libraryCode;
	}
}
