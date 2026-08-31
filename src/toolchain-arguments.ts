import path from 'path';

export function removeSourceArgument(args: readonly string[], sourceFile: string, workingDirectory?: string): string[] {
	return args.filter((argument) => !samePath(argument, sourceFile, workingDirectory));
}

export function samePath(left: string, right: string, workingDirectory?: string): boolean {
	if (!left || !right) {
		return false;
	}
	const normalizedLeft =
		workingDirectory && !path.isAbsolute(left) ? path.resolve(workingDirectory, left) : path.normalize(left);
	const normalizedRight =
		workingDirectory && !path.isAbsolute(right) ? path.resolve(workingDirectory, right) : path.normalize(right);
	return process.platform === 'win32'
		? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
		: normalizedLeft === normalizedRight;
}
