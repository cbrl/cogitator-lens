import path from 'path';

const flagsWithSeparateValues = new Set(['-o', '-MF', '-MT', '-MQ', '/Fo', '/Fa', '/Fd']);
const extensionOwnedFlags = new Set([
	'-S',
	'-c',
	'-M',
	'-MM',
	'-MD',
	'-MMD',
	'/c',
	'/FA',
	'/FAc',
	'/FAs',
	'/FAcs',
]);

export function sanitizeCompilerArguments(args: readonly string[], sourceFile: string): string[] {
	const result: string[] = [];
	for (let index = 0; index < args.length; index++) {
		const argument = args[index];
		if (samePath(argument, sourceFile) || extensionOwnedFlags.has(argument)) {
			continue;
		}
		if (flagsWithSeparateValues.has(argument)) {
			index++;
			continue;
		}
		if (/^(?:-o|-MF|-MT|-MQ|\/Fo|\/Fa|\/Fd).+/.test(argument)) {
			continue;
		}
		result.push(argument);
	}
	return result;
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

function samePath(left: string, right: string): boolean {
	if (!left || !right) {
		return false;
	}
	const normalizedLeft = path.normalize(left);
	const normalizedRight = path.normalize(right);
	return process.platform === 'win32'
		? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
		: normalizedLeft === normalizedRight;
}
