import type { ArtifactKind, RenderedTextArtifact } from '../types/index.js';
import type { AssemblyInstructionInfo } from '../vendor/types/assembly-docs.interfaces.js';
import type { BaseAssemblyDocumentationProvider } from '../vendor/lib/asm-docs/base.js';
import { Amd64DocumentationProvider } from '../vendor/lib/asm-docs/amd64.js';
import {
	Arm32DocumentationProvider,
	ArmArch64DocumentationProvider,
} from '../vendor/lib/asm-docs/arm.js';
import { LLVMDocumentationProvider } from '../vendor/lib/asm-docs/llvm.js';
import { PythonDocumentationProvider } from '../vendor/lib/asm-docs/python.js';
import { Riscv64DocumentationProvider } from '../vendor/lib/asm-docs/riscv64.js';

export interface InstructionDocumentation {
	readonly mnemonic: string;
	readonly instructionSet: string;
	readonly tooltip: string;
	readonly url: string;
}

interface NamedProvider {
	readonly label: string;
	readonly provider: BaseAssemblyDocumentationProvider;
}

const llvmProvider: NamedProvider = {
	label: 'LLVM IR',
	provider: new LLVMDocumentationProvider(),
};
const pythonProvider: NamedProvider = {
	label: 'Python bytecode',
	provider: new PythonDocumentationProvider(),
};

// Put AMD64 first so a listing containing only architecture-neutral mnemonics
// gets the extension's conventional host target. Distinctive opcodes in a
// normal listing cause the scoring below to select the actual instruction set.
const assemblyProviders: readonly NamedProvider[] = [
	{ label: 'x86 / AMD64', provider: new Amd64DocumentationProvider() },
	{ label: 'AArch64', provider: new ArmArch64DocumentationProvider() },
	{ label: 'ARM32', provider: new Arm32DocumentationProvider() },
	{ label: 'RISC-V', provider: new Riscv64DocumentationProvider() },
];

const inferredProviders = new WeakMap<RenderedTextArtifact, NamedProvider>();

/**
 * Looks up documentation emitted by Compiler Explorer's docenizers.
 *
 * LLVM IR and Python bytecode identify their instruction set through the
 * artifact kind. Assembly target architecture is not currently part of a
 * compilation profile, so it is inferred once per rendered listing by scoring
 * its distinct mnemonics against each documentation set.
 */
export function documentationForInstruction(
	artifact: RenderedTextArtifact,
	text: string,
): InstructionDocumentation | undefined {
	const mnemonic = instructionMnemonic(artifact.kind, text);
	if (!mnemonic) {
		return undefined;
	}
	return documentationForOpcode(artifact, mnemonic);
}

/** Looks up an opcode directly in the docenizer-generated instruction table. */
export function documentationForOpcode(
	artifact: RenderedTextArtifact,
	mnemonic: string,
): InstructionDocumentation | undefined {
	const namedProvider = providerForArtifact(artifact);
	if (!namedProvider) {
		return undefined;
	}
	const information = namedProvider.provider.getInstructionInformation(mnemonic);
	return information ? documentation(mnemonic, namedProvider, information) : undefined;
}

export function instructionMnemonic(kind: ArtifactKind, text: string): string | undefined {
	if (kind === 'python-bytecode') {
		// dis output: optional source line, current/jump markers, bytecode offset,
		// then the uppercase opcode.
		return /^\s*(?:\d+\s+)?(?:(?:-->)?\s*(?:>>)?\s*)?(?:\d+\s+)?([A-Z][A-Z0-9_]*)\b/u
			.exec(text)?.[1]?.toLowerCase();
	}
	if (kind === 'llvm-ir') {
		// Cover both terminators and value-producing instructions, including the
		// call instruction's optional tail-call marker.
		return /^\s*(?:[%@](?:[-\w.$]+|"[^"]+")\s*=\s*)?(?:(?:musttail|notail|tail)\s+)?([a-z][\w.]*)\b/iu
			.exec(text)?.[1]?.toLowerCase();
	}
	if (kind !== 'assembly' && kind !== 'binary-disassembly') {
		return undefined;
	}
	return /^\s*(?:[.$_a-zA-Z][\w.$@?]*:\s*)?([a-zA-Z][\w.]*)/u
		.exec(text)?.[1]?.toLowerCase();
}

function providerForArtifact(artifact: RenderedTextArtifact): NamedProvider | undefined {
	if (artifact.kind === 'llvm-ir') {
		return llvmProvider;
	}
	if (artifact.kind === 'python-bytecode') {
		return pythonProvider;
	}
	if (artifact.kind !== 'assembly' && artifact.kind !== 'binary-disassembly') {
		return undefined;
	}
	const cached = inferredProviders.get(artifact);
	if (cached) {
		return cached;
	}
	const inferred = inferAssemblyProvider(artifact);
	inferredProviders.set(artifact, inferred);
	return inferred;
}

function inferAssemblyProvider(artifact: RenderedTextArtifact): NamedProvider {
	const mnemonics = new Set<string>();
	for (const line of artifact.lines) {
		const mnemonic = instructionMnemonic(artifact.kind, line.disassembly ?? line.text);
		if (mnemonic) {
			mnemonics.add(mnemonic);
		}
		if (mnemonics.size >= 256) {
			break;
		}
	}

	const scores = assemblyProviders.map(() => 0);
	for (const mnemonic of mnemonics) {
		const matches = assemblyProviders
			.map((candidate, index) => candidate.provider.getInstructionInformation(mnemonic) ? index : -1)
			.filter(index => index >= 0);
		for (const index of matches) {
			// An opcode present in one set is stronger evidence than ADD/MOV-style
			// mnemonics shared by several architectures.
			scores[index] += 1 / matches.length;
		}
	}
	let bestIndex = 0;
	for (let index = 1; index < scores.length; index++) {
		if (scores[index] > scores[bestIndex]) {
			bestIndex = index;
		}
	}
	return assemblyProviders[bestIndex];
}

function documentation(
	mnemonic: string,
	provider: NamedProvider,
	information: AssemblyInstructionInfo,
): InstructionDocumentation {
	return {
		mnemonic,
		instructionSet: provider.label,
		tooltip: information.tooltip.trim(),
		url: information.url,
	};
}
