export class CommandLineSyntaxError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'CommandLineSyntaxError';
	}
}

export function tokenizeCommandLine(command: string, platform: 'posix' | 'windows'): string[] {
	return platform === 'windows' ? tokenizeWindows(command) : tokenizePosix(command);
}

/** Tokenize according to POSIX shell quoting rules without performing expansion. */
export function tokenizePosix(command: string): string[] {
	const result: string[] = [];
	let current = '';
	let quote: 'single' | 'double' | undefined;
	let tokenStarted = false;

	for (let index = 0; index < command.length; index++) {
		const character = command[index];
		if (!quote && /\s/.test(character)) {
			if (tokenStarted) {
				result.push(current);
				current = '';
				tokenStarted = false;
			}
			continue;
		}
		if (character === "'" && quote !== 'double') {
			quote = quote === 'single' ? undefined : 'single';
			tokenStarted = true;
			continue;
		}
		if (character === '"' && quote !== 'single') {
			quote = quote === 'double' ? undefined : 'double';
			tokenStarted = true;
			continue;
		}
		if (character === '\\' && quote !== 'single') {
			const next = command[index + 1];
			if (next === undefined) {
				throw new CommandLineSyntaxError('Trailing escape in command line');
			}
			if (!quote || next === '"' || next === '\\' || next === '$' || next === '`' || next === '\n') {
				current += next;
				index++;
				tokenStarted = true;
				continue;
			}
		}

		current += character;
		tokenStarted = true;
	}

	if (quote) {
		throw new CommandLineSyntaxError(`Unterminated ${quote}-quoted string`);
	}
	if (tokenStarted) {
		result.push(current);
	}

	return result;
}

/** Tokenize using the CommandLineToArgvW quote/backslash algorithm. */
export function tokenizeWindows(command: string): string[] {
	const result: string[] = [];
	let index = 0;

	while (index < command.length) {
		while (index < command.length && /\s/.test(command[index])) {
			index++;
		}
		if (index >= command.length) {
			break;
		}

		let argument = '';
		let inQuotes = false;
		while (index < command.length && (inQuotes || !/\s/.test(command[index]))) {
			let backslashes = 0;
			while (command[index] === '\\') {
				backslashes++;
				index++;
			}

			if (command[index] === '"') {
				argument += '\\'.repeat(Math.floor(backslashes / 2));

				if (backslashes % 2 === 0) {
					if (inQuotes && command[index + 1] === '"') {
						argument += '"';
						index++;
					} else {
						inQuotes = !inQuotes;
					}
				} else {
					argument += '"';
				}

				index++;
			} else {
				argument += '\\'.repeat(backslashes);
				if (index < command.length) {
					argument += command[index++];
				}
			}
		}
		result.push(argument);
	}

	return result;
}
