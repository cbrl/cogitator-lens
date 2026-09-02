import * as Path from 'path';
import vscode from 'vscode';

export function replaceExtension(filename: string, extension: string): string {
	return Path.join(Path.dirname(filename), Path.basename(filename, Path.extname(filename)) + extension);
}

/// Compares two URIs for equality, with options to ignore the fragment and/or case sensitivity of the path.
export function equalUri(
	uri1: vscode.Uri | undefined,
	uri2: vscode.Uri | undefined,
	ignoreFragment: boolean = false,
	ignorePathCase: boolean = false,
): boolean {
	if (uri1 === uri2) {
		return true;
	}
	if (!uri1 || !uri2) {
		return false;
	}
	return (
		toComparisonKey(uri1, ignoreFragment, ignorePathCase) === toComparisonKey(uri2, ignoreFragment, ignorePathCase)
	);
}

/// Converts a URI to a string key for comparison, with options to ignore the fragment and/or case sensitivity of the path.
export function toComparisonKey(
	uri: vscode.Uri,
	ignoreFragment: boolean = false,
	ignorePathCase: boolean = false,
): string {
	return uri
		.with({
			path: ignorePathCase ? uri.path.toLowerCase() : undefined, // 'undefined' will result in no change to the segment
			fragment: ignoreFragment ? '' : undefined,
		})
		.toString();
}

/// Structural equality for plain JSON-serializable values (order-sensitive for object keys and arrays).
export function structurallyEqual<T>(left: T, right: T): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

/** Whether a command line contains either `--name` or `--name=value`. */
export function hasOption(args: readonly string[], name: string): boolean {
	return args.some((argument) => argument === name || argument.startsWith(`${name}=`));
}
