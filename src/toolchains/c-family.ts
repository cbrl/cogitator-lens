import { AsmParser } from '../vendor/lib/parsers/asm-parser.js';
import { noopPropertyGetter } from '../vendor/compiler-props.js';
import { outputProducer } from '../artifacts/core/compiler-output-producer.js';
import { parseMakeDepfile } from '../compilation/artifact-inputs.js';
import type { DependencyCollectionSpec } from './toolchain-backend.js';
import { withoutOwnedArguments, type OwnedArguments } from './toolchain-contracts.js';

export const cFamilyLanguageIdentifiers = Object.freeze(['c', 'cpp', 'objective-c', 'objective-cpp', 'cuda']);

/** Creates GCC/Clang arguments for a file-backed assembly or object artifact. */
export function gnuOutputArguments(lineTableArguments: readonly string[]) {
	return (target: 'assembly' | 'object', outputFile: string): readonly string[] =>
		target === 'assembly'
			? ['-S', ...lineTableArguments, '-o', outputFile]
			: ['-c', ...lineTableArguments, '-o', outputFile];
}

export const gnuDependencyCollection: DependencyCollectionSpec = Object.freeze({
	outputFilename: 'dependencies.d',
	arguments: (outputFile: string) => ['-M', '-MF', outputFile],
	parse: parseMakeDepfile,
});

export const gnuPreprocessedSourceProducer = outputProducer({
	output: 'stdout',
	arguments: () => ['-E'],
});

export const clangAstProducer = outputProducer({
	output: 'stdout',
	arguments: () => ['-Xclang', '-ast-dump', '-fsyntax-only'],
	acceptOutputOnError: true,
});

export const gnuIntelArguments = Object.freeze(['-masm=intel']);
export const defaultAsmParser = (): AsmParser => new AsmParser(noopPropertyGetter);

const flagsWithSeparateValues = new Set([
	'-o',
	'-MF',
	'-MT',
	'-MQ',
	'-dumpdir',
	'-foptimization-record-file',
	'/clang:-o',
	'/clang:-foptimization-record-file',
	'/Fo',
	'/Fa',
	'/Fd',
	'/Fi',
	'/sourceDependencies',
]);
const flagsWithJoinedValues = /^(?:-o|-MF|-MT|-MQ|-dumpdir=|\/[Ff][OoAaDdIi]|\/[Ss]ource[Dd]ependencies:).+/;
const artifactOutputFlags =
	/^(?:-emit-llvm|-fdump-tree-cfg(?:-[^=]+)*(?:=.*)?|-save-temps(?:=.*)?|-f(?:no-)?stack-usage|-fsave-optimization-record(?:=.*)?|-foptimization-record-file(?:=.*)?|-fopt-info(?:-[^=]+)?(?:=.*)?|\/clang:-(?:emit-llvm|S|gline-tables-only|save-temps(?:=.*)?|f(?:no-)?stack-usage|fsave-optimization-record(?:=.*)?|foptimization-record-file(?:=.*)?))$/;
const compilerManagedFlags = new Set([
	'-S',
	'-c',
	'-E',
	'-fsyntax-only',
	'-M',
	'-MM',
	'-MD',
	'-MMD',
	'/c',
	'/FA',
	'/FAc',
	'/FAs',
	'/FAcs',
	'/E',
	'/EP',
	'/P',
]);

/** Source, output, dependency, and artifact switches owned by the C-family backend. */
export const compilerOwnedArguments: OwnedArguments = {
	withValue: [
		flagsWithSeparateValues,
		(argument, index, args) => argument === '-Xclang' && args[index + 1] === '-ast-dump',
	],
	standalone: [compilerManagedFlags, flagsWithJoinedValues, artifactOutputFlags],
};

export function stripCompilerManagedArguments(
	args: readonly string[],
	sourceFile: string,
	workingDirectory?: string,
): string[] {
	return withoutOwnedArguments(args, sourceFile, workingDirectory, compilerOwnedArguments);
}
