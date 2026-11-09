import fs from 'node:fs/promises';
import path from 'node:path';
import { noopPropertyGetter } from '../vendor/compiler-props.js';
import { GoAsmParser } from '../vendor/lib/parsers/asm-parser-go.js';
import { parseGoSsaControlFlowGraphs } from '../artifacts/control-flow-graph/parsers/go-ssa-cfg-parser.js';
import { outputProducer } from '../artifacts/core/compiler-output-producer.js';
import { renderGoOptimizationRemarks } from '../artifacts/optimization-remarks/go-optimization-remarks.js';
import type { ArtifactOutputSpec } from './toolchain-backend.js';
import {
	controlFlowGraphOutput,
	subcommandFirst,
	type ArtifactProducer,
	type ToolchainDefinition,
	withoutOwnedArguments,
} from './toolchain-contracts.js';
import { parseGoDiagnostics } from './go/diagnostics.js';
import { goSourceOverlay } from './source-overlay.js';

const goFunctionPattern =
	/^\s*func\s+(?:\(\s*(?:[\p{L}_][\p{L}\p{N}_]*\s+)?(\*?\s*[\p{L}_][\p{L}\p{N}_]*)\s*\)\s*)?([\p{L}_][\p{L}\p{N}_]*)\s*\(/gmu;
const goPackagePattern = /^\s*package\s+([\p{L}_][\p{L}\p{N}_]*)\b/mu;

/**
 * Adds a compiler flag to the configured `-gcflags`. The last `-gcflags` applies, so it keeps the
 * configured flags.
 */
function goCompilerFlags(providerArguments: readonly string[], flag: string): string {
	const configuredGcFlags = providerArguments.reduce<string | undefined>((value, argument, index) => {
		if (argument.startsWith('-gcflags=')) {
			return argument.slice('-gcflags='.length);
		}
		return providerArguments[index - 1] === '-gcflags' ? argument : value;
	}, undefined);
	return `-gcflags=${configuredGcFlags ? `${configuredGcFlags} ` : ''}${flag}`;
}

/** Builds \`go build\` arguments, preserving any configured compiler flags for assembly output. */
export function goOutputArguments(
	target: 'assembly' | 'object',
	outputFile: string,
	providerArguments: readonly string[] = [],
): readonly string[] {
	return target === 'assembly'
		? ['build', '-a', goCompilerFlags(providerArguments, '-S'), '-o', outputFile]
		: ['build', '-o', outputFile];
}

/**
 * `-m=2` prints the inlining and escape analysis decisions on standard error. Go 1.24 and 1.26 keep
 * this output in the build cache and print it again for an unchanged package, so `-a` is not
 * necessary. A failed compile prints no remarks.
 */
export const goOptimizationRemarksOutput: ArtifactOutputSpec = Object.freeze({
	output: 'stderr',
	arguments: (_outputFile: string, temporaryDirectory: string, providerArguments: readonly string[]) => [
		'build',
		goCompilerFlags(providerArguments, '-m=2'),
		'-o',
		path.join(temporaryDirectory, 'output.exe'),
	],
});

/** Removes \`go build\` subcommands, generated output paths, and the source path from provider arguments. */
export function stripGoManagedArguments(
	args: readonly string[],
	sourceFile: string,
	workingDirectory: string,
): string[] {
	return withoutOwnedArguments(args, sourceFile, workingDirectory, {
		withValue: [new Set(['-o'])],
		standalone: [
			(argument, index) => index === 0 && ['build', 'run', 'install'].includes(argument),
			(argument, index, all) => index <= 1 && all[0] === 'tool' && ['tool', 'compile'].includes(argument),
			/^-o=/,
		],
	});
}

export const goAssemblyProducer: ArtifactProducer = (backend, source, options, cancellationToken) =>
	backend.produceArtifact(
		source,
		options,
		{
			output: 'stderr',
			arguments: (_outputFile, temporaryDirectory, providerArguments) =>
				goOutputArguments('assembly', path.join(temporaryDirectory, 'output.exe'), providerArguments),
		},
		cancellationToken,
	);

export const goSsaControlFlowGraphProducer: ArtifactProducer = async (backend, source, options, cancellationToken) => {
	const configured = options.env?.GOSSAFUNC ?? backend.profile.environment.GOSSAFUNC;
	// Unsaved text names the functions that the compile sees.
	const functionName =
		configured?.replace(/\+$/u, '') ||
		(options.sourceOverlay ? goSsaFunctionOf(options.sourceOverlay.text) : await inferGoSsaFunction(source.fsPath));
	if (!functionName) {
		throw new Error(
			'No Go function could be selected for GOSSAFUNC. Configure GOSSAFUNC in the toolchain or invocation environment.',
		);
	}
	return backend.produceArtifact(
		source,
		{
			...options,
			env: {
				...options.env,
				GOSSAFUNC: `${functionName}+`,
			},
		},
		{
			output: 'stderr',
			environment: (temporaryDirectory) => ({ GOSSADIR: temporaryDirectory }),
			arguments: (_outputFile, temporaryDirectory) => [
				'build',
				'-a',
				'-o',
				path.join(temporaryDirectory, 'output.exe'),
			],
		},
		cancellationToken,
	);
};

/** Selects a stable source function name suitable for \`GOSSAFUNC\` when none is configured. */
export async function inferGoSsaFunction(filename: string): Promise<string | undefined> {
	return goSsaFunctionOf(await fs.readFile(filename, 'utf8'));
}

/** Selects the \`GOSSAFUNC\` function of a Go source text. */
export function goSsaFunctionOf(source: string): string | undefined {
	const functions = [...source.matchAll(goFunctionPattern)].map((match) => ({
		receiver: match[1]?.replaceAll(/\s+/gu, ''),
		name: match[2],
	}));
	const selected =
		functions.find((candidate) => !candidate.receiver && candidate.name !== 'init') ??
		functions.find((candidate) => candidate.name !== 'init') ??
		functions[0];
	const packageName = goPackagePattern.exec(source)?.[1];
	if (!selected) {
		return undefined;
	}
	if (selected.receiver) {
		return `(${selected.receiver}).${selected.name}`;
	}
	return packageName
		? `${packageName === 'main' ? 'main' : 'command-line-arguments'}.${selected.name}`
		: selected.name;
}

export const go: ToolchainDefinition = {
	executablePattern: /^go(?:\.exe)?$/i,
	parseDiagnostics: parseGoDiagnostics,
	languageIdentifiers: Object.freeze(['go']),
	stripOwnedArguments: stripGoManagedArguments,
	assembleArguments: subcommandFirst,
	sourceOverlay: goSourceOverlay,
	createParser: () => new GoAsmParser(noopPropertyGetter),
	artifacts: {
		assembly: { producer: goAssemblyProducer },
		'optimization-remarks': {
			producer: outputProducer(goOptimizationRemarksOutput),
			renderer: renderGoOptimizationRemarks,
		},
		'control-flow-graph': {
			outputs: [
				controlFlowGraphOutput(
					'go-ssa',
					'Go SSA CFG',
					'Build a source-level graph from the final GOSSAFUNC SSA snapshot.',
					goSsaControlFlowGraphProducer,
					(raw, _options, context) => parseGoSsaControlFlowGraphs(raw.text, context.source.uri.toString()),
				),
			],
		},
	},
};
