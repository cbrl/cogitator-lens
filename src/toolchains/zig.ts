import path from 'node:path';

export function zigOutputArguments(
	target: 'assembly' | 'object',
	outputFile: string,
): readonly string[] {
	return target === 'assembly'
		? ['build-obj', '-fllvm', '-fno-strip', '-fno-emit-bin', `-femit-asm=${outputFile}`]
		: ['build-obj', '-fllvm', '-fno-strip', `-femit-bin=${outputFile}`];
}

export const zigLlvmIrOutput = Object.freeze({
	output: { filename: 'output.ll' },
	arguments: (outputFile: string) => [
		'build-obj',
		'-fllvm',
		'-fno-strip',
		'-fno-emit-bin',
		`-femit-llvm-ir=${outputFile}`,
	],
});

export function stripZigManagedArguments(
	args: readonly string[],
	sourceFile: string,
	workingDirectory: string,
): string[] {
	const source = path.resolve(sourceFile);
	const result: string[] = [];
	for (let index = 0; index < args.length; index++) {
		const argument = args[index];
		if (index === 0 && /^build-(?:obj|exe|lib)$/u.test(argument)) {
			continue;
		}
		if (path.resolve(workingDirectory, argument) === source) {
			continue;
		}
		if (['--cache-dir', '--global-cache-dir', '--name'].includes(argument)) {
			index++;
			continue;
		}
		if (/^(?:--(?:cache-dir|global-cache-dir|name)=|-f(?:no-)?emit-(?:bin|asm|llvm-ir)(?:=|$))/u.test(argument)) {
			continue;
		}
		result.push(argument);
	}
	return result;
}
