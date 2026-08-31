import type { ControlFlowSourceLocation } from '../../../types/index.js';
import { compilerSourceUri, isAbsoluteCompilerPath } from '../cfg-parser-support.js';
import { decodeLlvmString } from '../../llvm-ir/llvm-names.js';

/**
 * Resolution of LLVM debug metadata into editor positions.
 *
 * Compiler Explorer's CFG parser has no equivalent: it keeps `!dbg !N` inside
 * the node's label text and never resolves it, because its graph nodes carry no
 * source position. Every block in a graph produced here is navigable, so the
 * `!dbg` -> `!DILocation` -> scope chain -> `!DIFile` walk is done up front and
 * the results are keyed by metadata ID.
 */

/** Resolved `!dbg` locations keyed by metadata ID. */
export type MetadataTable = ReadonlyMap<number, ControlFlowSourceLocation>;

export function parseMetadata(lines: readonly string[], workingDirectory: string): MetadataTable {
	const records = new Map<number, string>();
	for (let line = 0; line < lines.length; line++) {
		const match = /^\s*!(\d+)\s*=\s*(.*)$/u.exec(lines[line]);
		if (!match) {
			continue;
		}
		let value = match[2];
		while (!balancedMetadata(value) && line + 1 < lines.length) {
			line++;
			value += ` ${lines[line].trim()}`;
		}
		records.set(Number.parseInt(match[1], 10), value);
	}

	const files = new Map<number, string>();
	for (const [id, record] of records) {
		if (!/!DIFile\b/u.test(record)) {
			continue;
		}
		const filename = metadataString(record, 'filename');
		if (filename) {
			// A DIFile splits the path into a directory and a filename; the
			// directory is dropped when the filename is already absolute.
			const directory = metadataString(record, 'directory');
			const combined = directory && !isAbsoluteCompilerPath(filename)
				? `${directory}/${filename}`
				: filename;
			files.set(id, compilerSourceUri(combined, workingDirectory));
		}
	}

	const locations = new Map<number, ControlFlowSourceLocation>();
	const resolving = new Set<number>();
	for (const id of records.keys()) {
		const location = resolveLocation(id, records, files, resolving);
		if (location) {
			locations.set(id, location);
		}
	}
	return locations;
}

function resolveLocation(
	id: number,
	records: ReadonlyMap<number, string>,
	files: ReadonlyMap<number, string>,
	resolving: Set<number>,
): ControlFlowSourceLocation | undefined {
	if (resolving.has(id)) {
		return undefined;
	}
	const record = records.get(id);
	if (!record) {
		return undefined;
	}
	resolving.add(id);
	try {
		const lineValue = metadataNumber(record, 'line');
		const columnValue = metadataNumber(record, 'column');
		const fileRef = metadataReference(record, 'file');
		const scopeRef = metadataReference(record, 'scope');
		const inlinedAtRef = metadataReference(record, 'inlinedAt');
		const file = fileRef === undefined
			? scopeRef === undefined ? undefined : resolveScopeFile(scopeRef, records, files, resolving)
			: files.get(fileRef) ?? resolveScopeFile(fileRef, records, files, resolving);
		const nested = inlinedAtRef === undefined
			? undefined
			: resolveLocation(inlinedAtRef, records, files, resolving);
		const line = lineValue === undefined
			? nested?.line
			: Math.max(0, lineValue - 1);
		if (!file || line === undefined || line < 0) {
			return nested;
		}
		return {
			uri: file,
			line,
			column: columnValue === undefined
				? nested?.column ?? 0
				: Math.max(0, columnValue - 1),
		};
	} finally {
		resolving.delete(id);
	}
}

function resolveScopeFile(
	id: number,
	records: ReadonlyMap<number, string>,
	files: ReadonlyMap<number, string>,
	resolving: Set<number>,
): string | undefined {
	if (files.has(id)) {
		return files.get(id);
	}
	if (resolving.has(id)) {
		return undefined;
	}
	const record = records.get(id);
	if (!record) {
		return undefined;
	}
	resolving.add(id);
	try {
		const directFile = metadataReference(record, 'file');
		if (directFile !== undefined && files.has(directFile)) {
			return files.get(directFile);
		}
		const scope = metadataReference(record, 'scope');
		return scope === undefined ? undefined : resolveScopeFile(scope, records, files, resolving);
	} finally {
		resolving.delete(id);
	}
}

function metadataReference(text: string, key: string): number | undefined {
	const match = new RegExp(`\\b${key}\\s*:\\s*!(\\d+)`, 'u').exec(text);
	return match ? Number.parseInt(match[1], 10) : undefined;
}

function metadataNumber(text: string, key: string): number | undefined {
	const match = new RegExp(`\\b${key}\\s*:\\s*(-?\\d+)`, 'u').exec(text);
	return match ? Number.parseInt(match[1], 10) : undefined;
}

function metadataString(text: string, key: string): string | undefined {
	const match = new RegExp(`\\b${key}\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`, 'u').exec(text);
	return match ? decodeLlvmString(match[1]) : undefined;
}

function balancedMetadata(value: string): boolean {
	let depth = 0;
	let quoted = false;
	let escaped = false;
	for (const character of value) {
		if (escaped) {
			escaped = false;
			continue;
		}
		if (character === '\\') {
			escaped = true;
			continue;
		}
		if (character === '"') {
			quoted = !quoted;
		} else if (!quoted && character === '(') {
			depth++;
		} else if (!quoted && character === ')') {
			depth--;
		}
	}
	return depth <= 0 && !quoted;
}
