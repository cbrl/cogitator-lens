import fs from 'node:fs/promises';
import path from 'node:path';
import { noopPropertyGetter } from '../vendor/compiler-props.js';
import { GoAsmParser } from '../vendor/lib/parsers/asm-parser-go.js';
import { parseGoSsaControlFlowGraphs } from '../artifacts/control-flow-graph/parsers/go-ssa-cfg-parser.js';
import {
	controlFlowGraphOutput,
	subcommandFirst,
	type ArtifactProducer,
	type ToolchainDefinition,
	withoutOwnedArguments,
} from './toolchain-contracts.js';
import { parseGoDiagnostics } from './go/diagnostics.js';

const goFunctionPattern =
	/^\s*func\s+(?:\(\s*(?:[\p{L}_][\p{L}\p{N}_]*\s+)?(\*?\s*[\p{L}_][\p{L}\p{N}_]*)\s*\)\s*)?([\p{L}_][\p{L}\p{N}_]*)\s*\(/gmu;
const goPackagePattern = /^\s*package\s+([\p{L}_][\p{L}\p{N}_]*)\b/mu;

/** Builds \`go build\` arguments, preserving any configured compiler flags for assembly output. */
export function goOutputArguments(
	target: 'assembly' | 'object',
	outputFile: string,
	providerArguments: readonly string[] = [],
): readonly string[] {
	const configuredGcFlags = providerArguments.reduce<string | undefined>((value, argument, index) => {
		if (argument.startsWith('-gcflags=')) {
			return argument.slice('-gcflags='.length);
		}
		return providerArguments[index - 1] === '-gcflags' ? argument : value;
	}, undefined);
	return target === 'assembly'
		? ['build', '-a', `-gcflags=${configuredGcFlags ? `${configuredGcFlags} ` : ''}-S`, '-o', outputFile]
		: ['build', '-o', outputFile];
}

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
	const functionName = configured?.replace(/\+$/u, '') || (await inferGoSsaFunction(source.fsPath));
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
	const source = await fs.readFile(filename, 'utf8');
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
	createParser: () => new GoAsmParser(noopPropertyGetter),
	artifacts: {
		assembly: { producer: goAssemblyProducer },
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
