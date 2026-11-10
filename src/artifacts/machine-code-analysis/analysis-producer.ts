import fs from 'node:fs';
import type { ArtifactImplementation, ArtifactProducer } from '../../toolchains/toolchain-contracts.js';
import {
	architectureOfTriple,
	targetFromArguments,
	toolchainTarget,
	withX86Mode,
} from '../../toolchains/target-architecture.js';
import type { TargetArchitecture } from '../../types/index.js';
import { markAnalysisRegions, type AnalysisRegion } from './analysis-regions.js';

/** The data that the producer keeps for the renderer: the regions of the analysis, in their order. */
export interface AnalysisData {
	readonly regions: readonly AnalysisRegion[];
}

/** The key of llvm-mca in the auxiliary tools of a toolchain profile. */
export const analyzerTool = 'analyzer';

/**
 * The processor that llvm-mca models. A compiler argument selects it: `-mcpu`, also in the `/clang:`
 * form, `-march` for x86, where it names a processor, or `-C target-cpu` for rustc. The last one
 * applies. Without one, llvm-mca models a generic processor, not the processor of this computer, so
 * the result does not depend on the computer.
 */
export function analysisProcessor(args: readonly string[], architecture: TargetArchitecture | undefined): string {
	let processor: string | undefined;
	args.forEach((argument, index) => {
		const option = /^(?:\/clang:)?-mcpu=(.+)$/u.exec(argument)?.[1];
		const x86Architecture = architecture === 'x86' ? /^(?:\/clang:)?-march=(.+)$/u.exec(argument)?.[1] : undefined;
		const rustProcessor =
			/^-Ctarget-cpu=(.+)$/u.exec(argument)?.[1] ??
			(argument === '-C' ? /^target-cpu=(.+)$/u.exec(args[index + 1] ?? '')?.[1] : undefined);
		processor = option ?? x86Architecture ?? rustProcessor ?? processor;
	});
	return processor ?? 'generic';
}

/**
 * Compiles assembly, marks each function as a code region, and runs llvm-mca on it. The target and
 * the processor come from the compiler arguments, so llvm-mca models the code that the compiler
 * made for them.
 */
export const machineCodeAnalysisProducer: ArtifactProducer = async (backend, source, options, cancellationToken) => {
	const { outputArguments } = backend.definition;
	if (!outputArguments) {
		throw new Error(`${backend.profile.displayName} has no assembly production capability.`);
	}
	const args = [...backend.profile.defaultArguments, ...(options.args ?? [])];
	const target = withX86Mode(targetFromArguments(args) ?? (await toolchainTarget(backend.profile)), args);
	const architecture = architectureOfTriple(target);
	const analysisArguments = [
		...(target ? [`-mtriple=${target}`] : []),
		`-mcpu=${analysisProcessor(args, architecture)}`,
		...(options.productionOptions.intel && architecture === 'x86' ? ['-output-asm-variant=1'] : []),
	];
	return backend.produceWithTool(
		source,
		options,
		{
			workspaceFiles: { assembly: 'output.s', analysis: 'analysis.s' },
			compilerArguments: (files, providerArguments) =>
				outputArguments('assembly', files.assembly, providerArguments),
			tool: analyzerTool,
			toolArguments: (files) => [...analysisArguments, files.analysis],
			producerData: async (files) => {
				const marked = markAnalysisRegions(await fs.promises.readFile(files.assembly, 'utf8'), architecture);
				await fs.promises.writeFile(files.analysis, marked.text);
				return { regions: marked.regions } satisfies AnalysisData;
			},
			demangle: true,
		},
		cancellationToken,
	);
};

/** The analysis needs llvm-mca, which a toolchain finds beside its compiler or on the PATH. */
export const machineCodeAnalysis: ArtifactImplementation = {
	producer: machineCodeAnalysisProducer,
	requiredTools: [{ name: analyzerTool, label: 'llvm-mca' }],
};
