import path from 'path';
import type { CancellationToken, Uri } from 'vscode';
import type {
	CompileOptions,
	RawArtifact,
} from '../types/index.js';
import type { ToolchainBackend } from '../toolchains/toolchain-backend.js';

const flagsWithSeparateValues = new Set(['-o', '-MF', '-MT', '-MQ', '/Fo', '/Fa', '/Fd']);
const assemblyOwnedFlags = new Set([
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

export async function produceAssembly(
	backend: ToolchainBackend,
	source: Uri,
	options: CompileOptions,
	cancellationToken: CancellationToken,
): Promise<RawArtifact> {
	const result = await backend.produceAssembly(source.fsPath, {
		...options,
		args: sanitizeAssemblyArguments(
			options.args ?? [],
			source.fsPath,
			options.workingDirectory,
		),
	}, cancellationToken);
	const { stdout, stderr, ...raw } = result;
	const { parseToolDiagnostics } = await import('../diagnostics.js');
	return {
		...raw,
		diagnostics: parseToolDiagnostics(
			`${stderr}\n${stdout}`,
			source,
			options.workingDirectory ?? path.dirname(source.fsPath),
		),
	};
}

export function sanitizeAssemblyArguments(
	args: readonly string[],
	sourceFile: string,
	workingDirectory?: string,
): string[] {
	const result: string[] = [];
	for (let index = 0; index < args.length; index++) {
		const argument = args[index];
		if (samePath(argument, sourceFile, workingDirectory) || assemblyOwnedFlags.has(argument)) {
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

function samePath(left: string, right: string, workingDirectory?: string): boolean {
	if (!left || !right) {
		return false;
	}
	const normalizedLeft = normalizePath(left, workingDirectory);
	const normalizedRight = normalizePath(right, workingDirectory);
	return process.platform === 'win32'
		? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
		: normalizedLeft === normalizedRight;
}

function normalizePath(value: string, workingDirectory?: string): string {
	return workingDirectory && !path.isAbsolute(value)
		? path.resolve(workingDirectory, value)
		: path.normalize(value);
}
