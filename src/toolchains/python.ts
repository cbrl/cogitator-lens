import { samePath } from '../toolchain-arguments.js';

export function stripPythonManagedArguments(
	args: readonly string[],
	sourceFile: string,
	workingDirectory: string,
): string[] {
	const result: string[] = [];
	for (let index = 0; index < args.length; index++) {
		const argument = args[index];
		if (samePath(argument, sourceFile, workingDirectory) || argument === '--') {
			continue;
		}
		if (argument === '-m' || argument === '-c') {
			index++;
			continue;
		}
		if (/^-[mc].+/.test(argument)) {
			continue;
		}
		result.push(argument);
	}
	return result;
}
