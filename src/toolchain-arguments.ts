import path from 'path';

export function removeSourceArgument(
	args: readonly string[],
	sourceFile: string,
	workingDirectory?: string,
): string[] {
	return args.filter(argument => !samePath(argument, sourceFile, workingDirectory));
}

export function redactArguments(args: readonly string[]): string[] {
	const secretFlags = /^(?:--?(?:password|token|secret|api[-_]?key)|\/(?:password|token))$/i;
	const assignment = /^([^=]*(?:password|token|secret|api[-_]?key)[^=]*)=(.*)$/i;
	return args.map((argument, index) => {
		if (index > 0 && secretFlags.test(args[index - 1])) {
			return '<redacted>';
		}
		const match = assignment.exec(argument);
		return match ? `${match[1]}=<redacted>` : argument;
	});
}

function samePath(left: string, right: string, workingDirectory?: string): boolean {
	if (!left || !right) {
		return false;
	}
	const normalizedLeft = workingDirectory && !path.isAbsolute(left)
		? path.resolve(workingDirectory, left)
		: path.normalize(left);
	const normalizedRight = workingDirectory && !path.isAbsolute(right)
		? path.resolve(workingDirectory, right)
		: path.normalize(right);
	return process.platform === 'win32'
		? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
		: normalizedLeft === normalizedRight;
}
