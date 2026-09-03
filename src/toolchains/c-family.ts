import { AsmParser } from '../vendor/lib/parsers/asm-parser.js';
import { noopPropertyGetter } from '../vendor/compiler-props.js';
import { artifactProducer } from '../artifacts/core/compiler-output-producer.js';
import { parseMakeDepfile } from '../compilation/artifact-inputs.js';
import type { DependencyCollectionSpec } from './toolchain-backend.js';
import { sameLocalFile } from '../local-file-identity.js';

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

export const gnuPreprocessedSourceProducer = artifactProducer('preprocessed-source', {
	output: 'stdout',
	arguments: () => ['-E'],
});

export const clangAstProducer = artifactProducer('ast', {
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

/** Removes source, output, dependency, and artifact switches owned by the C-family backend. */
export function stripCompilerManagedArguments(
	args: readonly string[],
	sourceFile: string,
	workingDirectory?: string,
): string[] {
	const result: string[] = [];
	for (let index = 0; index < args.length; index++) {
		const argument = args[index];
		if (sameLocalFile(argument, sourceFile, workingDirectory) || compilerManagedFlags.has(argument)) {
			continue;
		}
		if (flagsWithSeparateValues.has(argument)) {
			index++;
			continue;
		}
		if (argument === '-Xclang' && args[index + 1] === '-ast-dump') {
			index++;
			continue;
		}
		if (flagsWithJoinedValues.test(argument) || artifactOutputFlags.test(argument)) {
			continue;
		}
		result.push(argument);
	}
	return result;
}
