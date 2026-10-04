import * as Path from 'path';

export function replaceExtension(filename: string, extension: string): string {
	return Path.join(Path.dirname(filename), Path.basename(filename, Path.extname(filename)) + extension);
}

/// Structural equality for plain JSON-serializable values (order-sensitive for object keys and arrays).
export function structurallyEqual<T>(left: T, right: T): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

/** Whether a command line contains either `--name` or `--name=value`. */
export function hasOption(args: readonly string[], name: string): boolean {
	return args.some((argument) => argument === name || argument.startsWith(`${name}=`));
}
