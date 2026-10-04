import fs from 'node:fs';
import path from 'node:path';
import type { Uri } from 'vscode';

export interface LocalFileUri {
	readonly scheme: string;
	readonly fsPath: string;
	readonly query?: string;
	toString(): string;
}

/** Resolves a path lexically without changing the spelling retained by its owner. */
export function absoluteLocalPath(filename: string, workingDirectory?: string): string {
	return path.normalize(
		workingDirectory && !path.isAbsolute(filename)
			? path.resolve(workingDirectory, filename)
			: path.resolve(filename),
	);
}

/**
 * Resolves a compiler-reported path against the compiler's working directory.
 * Unlike `absoluteLocalPath`, an absolute path keeps its root, so no drive is added on Windows.
 */
export function resolveCompilerPath(filename: string, workingDirectory: string): string {
	return path.normalize(path.isAbsolute(filename) ? filename : path.resolve(workingDirectory, filename));
}

/**
 * Produces a physical identity for a local path. Existing paths are resolved
 * through symlinks. For a path that does not exist yet, the closest existing
 * parent is resolved so generated files beneath a symlinked directory still
 * share one identity.
 */
export function localFileComparisonKey(filename: string, workingDirectory?: string): string {
	const absolute = absoluteLocalPath(filename, workingDirectory);
	const canonical = canonicalLocalPath(absolute);
	return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

/** Returns a canonical path while also supporting a not-yet-created leaf. */
export function canonicalLocalPath(filename: string, workingDirectory?: string): string {
	return canonicalizeExistingPathOrParent(absoluteLocalPath(filename, workingDirectory));
}

/** Compares local paths by physical identity while retaining a cheap lexical fast path. */
export function sameLocalFile(left: string, right: string, workingDirectory?: string): boolean {
	if (!left || !right) {
		return false;
	}
	const absoluteLeft = absoluteLocalPath(left, workingDirectory);
	const absoluteRight = absoluteLocalPath(right, workingDirectory);
	const lexicalLeft = process.platform === 'win32' ? absoluteLeft.toLowerCase() : absoluteLeft;
	const lexicalRight = process.platform === 'win32' ? absoluteRight.toLowerCase() : absoluteRight;
	return (
		lexicalLeft === lexicalRight || localFileComparisonKey(absoluteLeft) === localFileComparisonKey(absoluteRight)
	);
}

/** Uses physical identity for file URIs and URI semantics for every other scheme. */
export function localFileUriComparisonKey(uri: LocalFileUri): string {
	if (uri.scheme !== 'file') {
		return uri.toString();
	}
	return JSON.stringify(['file', localFileComparisonKey(uri.fsPath), uri.query ?? '']);
}

function canonicalizeExistingPathOrParent(absolute: string): string {
	try {
		return path.normalize(fs.realpathSync.native(absolute));
	} catch {
		// Generated outputs and deleted watcher targets may not exist. Resolve the
		// nearest parent that does, then append the unresolved path components.
	}

	const suffix: string[] = [];
	let current = absolute;
	while (true) {
		const parent = path.dirname(current);
		if (parent === current) {
			return absolute;
		}
		suffix.unshift(path.basename(current));
		current = parent;
		try {
			return path.normalize(path.join(fs.realpathSync.native(current), ...suffix));
		} catch {
			// Continue toward the filesystem root.
		}
	}
}

/** Compares two URIs by their text. */
export function equalUri(left: Uri | undefined, right: Uri | undefined): boolean {
	return left === right || (left !== undefined && right !== undefined && left.toString() === right.toString());
}

/** A comparison key for a URI without its fragment, and without path case on Windows. */
export function uriComparisonKey(uri: Uri): string {
	return uri
		.with({ path: process.platform === 'win32' ? uri.path.toLowerCase() : uri.path, fragment: '' })
		.toString();
}

/** A comparison key for a source URI. Local paths are resolved through symlinks. */
export function sourceUriComparisonKey(uri: Uri): string {
	return uri.scheme === 'file' ? localFileUriComparisonKey(uri) : uriComparisonKey(uri);
}

/**
 * A map keyed by source identity. It keeps each key's original Uri, so iteration
 * returns the Uri as it was stored rather than one built from a comparison key.
 */
export class SourceUriMap<T> {
	private readonly entries = new Map<string, readonly [Uri, T]>();

	set(uri: Uri, value: T): this {
		this.entries.set(sourceUriComparisonKey(uri), [uri, value]);
		return this;
	}

	get(uri: Uri): T | undefined {
		return this.entries.get(sourceUriComparisonKey(uri))?.[1];
	}

	has(uri: Uri): boolean {
		return this.entries.has(sourceUriComparisonKey(uri));
	}

	delete(uri: Uri): boolean {
		return this.entries.delete(sourceUriComparisonKey(uri));
	}

	clear(): void {
		this.entries.clear();
	}

	*[Symbol.iterator](): IterableIterator<readonly [Uri, T]> {
		yield* this.entries.values();
	}

	*keys(): IterableIterator<Uri> {
		for (const [uri] of this.entries.values()) {
			yield uri;
		}
	}
}

/** A set of source URIs compared by source identity. It keeps each member's original Uri. */
export class SourceUriSet {
	private readonly entries = new Map<string, Uri>();

	add(uri: Uri): this {
		this.entries.set(sourceUriComparisonKey(uri), uri);
		return this;
	}

	has(uri: Uri): boolean {
		return this.entries.has(sourceUriComparisonKey(uri));
	}

	values(): IterableIterator<Uri> {
		return this.entries.values();
	}
}
