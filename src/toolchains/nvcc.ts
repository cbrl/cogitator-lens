import path from 'node:path';
import type { BinaryDisassembler } from './toolchain-backend.js';

export function nvccOutputArguments(target: 'assembly' | 'object', outputFile: string): readonly string[] {
	return target === 'assembly'
		? ['--ptx', '--generate-line-info', '--keep-device-functions', '-o', outputFile]
		: ['--cubin', '--generate-line-info', '--keep-device-functions', '-o', outputFile];
}

export const nvdisasm: BinaryDisassembler = Object.freeze({
	tool: 'disassembler',
	arguments: (binaryFile: string) => [binaryFile, '-c', '-g', '-hex'],
});

export function stripNvccManagedArguments(
	args: readonly string[],
	sourceFile: string,
	workingDirectory: string,
): string[] {
	const source = path.resolve(sourceFile);
	const result: string[] = [];
	for (let index = 0; index < args.length; index++) {
		const argument = args[index];
		if (path.resolve(workingDirectory, argument) === source) {
			continue;
		}
		if (['-o', '--output-file'].includes(argument)) {
			index++;
			continue;
		}
		if (
			/^(?:-o.+|--output-file=|--ptx$|-ptx$|--cubin$|-cubin$|--compile$|-c$|-S$|-E$|--generate-line-info$|-lineinfo$|--keep-device-functions$)/u.test(
				argument,
			)
		) {
			continue;
		}
		result.push(argument);
	}
	return result;
}
