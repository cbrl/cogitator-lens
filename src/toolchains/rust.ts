import { stripCompilerManagedArguments } from './toolchain-backend.js';

const rustManagedFlagsWithValues = new Set(['--emit', '--error-format', '--json', '--out-dir', '--color']);

const rustManagedFlagAssignments = /^(?:--emit|--error-format|--json|--out-dir|--color)=/;

export function rustOutputArguments(
	target: 'assembly' | 'object',
	outputFile: string,
	providerArguments: readonly string[],
): readonly string[] {
	return [
		...(hasOption(providerArguments, '--crate-name') ? [] : ['--crate-name=coglens_artifact']),
		...(hasOption(providerArguments, '--crate-type') ? [] : ['--crate-type=lib']),
		target === 'assembly' ? '--emit=asm' : '--emit=obj',
		'-C',
		'debuginfo=1',
		'--error-format=human',
		'--color=never',
		'-o',
		outputFile,
	];
}

export function stripRustManagedArguments(
	args: readonly string[],
	sourceFile: string,
	workingDirectory?: string,
): string[] {
	const stripped = stripCompilerManagedArguments(args, sourceFile, workingDirectory);
	const result: string[] = [];
	for (let index = 0; index < stripped.length; index++) {
		const argument = stripped[index];
		if (rustManagedFlagsWithValues.has(argument)) {
			index++;
			continue;
		}
		if (rustManagedFlagAssignments.test(argument)) {
			continue;
		}
		result.push(argument);
	}
	return result;
}

function hasOption(args: readonly string[], name: string): boolean {
	return args.some((argument) => argument === name || argument.startsWith(`${name}=`));
}
