import { sameLocalFile } from './local-file-identity.js';

export function removeSourceArgument(args: readonly string[], sourceFile: string, workingDirectory?: string): string[] {
	return args.filter((argument) => !sameLocalFile(argument, sourceFile, workingDirectory));
}
