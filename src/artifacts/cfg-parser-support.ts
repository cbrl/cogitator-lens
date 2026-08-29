import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Helpers shared by the control-flow-graph parsers.
 *
 * Every parser turns bounded compiler text into the same graph shape, so path
 * resolution, line splitting, and graph identity live here rather than being
 * reimplemented per dialect.
 */

/** Splits compiler output on any line ending without producing a trailing empty line. */
export function splitLines(text: string): string[] {
	const lines = text.split(/\r\n|\n|\r/u);
	if (lines.at(-1) === '') {
		lines.pop();
	}
	return lines;
}

/**
 * Resolves a compiler-reported path to a `file:` URI without depending on the
 * host running the extension.
 *
 * Compilers report either POSIX or Windows paths, and fixtures exercise both on
 * either host, so the convention is chosen from the path text rather than from
 * `process.platform`. Paths that are already URIs are passed through.
 */
export function compilerSourceUri(filename: string, workingDirectory: string): string {
	if (/^(?:file|vscode-remote):/iu.test(filename)) {
		return filename;
	}
	if (isWindowsAbsolute(filename)) {
		return windowsPathUri(filename);
	}
	if (isPosixAbsolute(filename)) {
		return posixPathUri(filename);
	}
	if (isWindowsAbsolute(workingDirectory)) {
		return windowsPathUri(path.win32.resolve(workingDirectory, filename));
	}
	if (isPosixAbsolute(workingDirectory)) {
		return posixPathUri(path.posix.resolve(workingDirectory, filename.replaceAll('\\', '/')));
	}
	return pathToFileURL(path.resolve(workingDirectory, filename)).href;
}

/**
 * Allocates graph IDs that stay stable when unrelated functions are added or
 * removed from the same compiler output.
 *
 * The ID is derived from the compiler's own function identity, so it never
 * depends on position; repeated identities gain an occurrence suffix.
 */
export class GraphIdAllocator {
	private readonly occurrences = new Map<string, number>();

	constructor(private readonly dialect: string) {}

	allocate(label: string): string {
		const base = `${this.dialect}:${encodeURIComponent(label)}`;
		const occurrence = (this.occurrences.get(base) ?? 0) + 1;
		this.occurrences.set(base, occurrence);
		return occurrence === 1 ? base : `${base}#${occurrence}`;
	}
}

/** Allocates node IDs unique within one graph, preferring the compiler's block identity. */
export class NodeIdAllocator {
	private readonly used = new Set<string>();

	allocate(identity: string, ordinal: number): string {
		const base = identity || `bb${ordinal}`;
		if (!this.used.has(base)) {
			this.used.add(base);
			return base;
		}
		let suffix = 2;
		while (this.used.has(`${base}#${suffix}`)) {
			suffix++;
		}
		const id = `${base}#${suffix}`;
		this.used.add(id);
		return id;
	}
}

/** Whether a compiler-reported path is absolute under either path convention. */
export function isAbsoluteCompilerPath(value: string): boolean {
	return isWindowsAbsolute(value) || isPosixAbsolute(value);
}

function isWindowsAbsolute(value: string): boolean {
	return /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith('\\\\');
}

function isPosixAbsolute(value: string): boolean {
	return value.startsWith('/');
}

function windowsPathUri(value: string): string {
	const normalized = value.replaceAll('\\', '/');
	return normalized.startsWith('//')
		? `file:${encodeUriPath(normalized)}`
		: `file:///${encodeUriPath(normalized)}`;
}

function posixPathUri(value: string): string {
	return `file://${encodeUriPath(path.posix.normalize(value.replaceAll('\\', '/')))}`;
}

function encodeUriPath(value: string): string {
	return value
		.split('/')
		.map(segment => encodeURIComponent(segment).replaceAll('%3A', ':'))
		.join('/');
}
