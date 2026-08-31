import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ArtifactInputState } from '../types/index.js';

export interface ArtifactInputMetadata {
	readonly inputs: readonly ArtifactInputState[];
	readonly dependencyCoverage: 'complete' | 'source-only';
}

/**
 * Parses Make-compatible depfiles produced by GCC, Clang, and rustc.
 * Escaped whitespace and line continuations are decoded while ordinary
 * Windows path separators remain intact.
 */
export function parseMakeDepfile(text: string, workingDirectory: string): string[] {
	const unfolded = text.replace(/\\(?:\r\n|\n|\r)/g, ' ');
	const dependencies: string[] = [];
	for (const rule of unfolded.split(/\r\n|\n|\r/)) {
		const separator = findRuleSeparator(rule);
		if (separator < 0) {
			continue;
		}
		dependencies.push(...parseMakeWords(rule.slice(separator + 1)));
	}
	return normalizeDependencyPaths(dependencies, workingDirectory);
}

/**
 * Accepts the documented `/sourceDependencies` JSON object. Module and
 * header-unit fields are intentionally ignored until they can be resolved to
 * stable local file identities.
 */
export function parseMsvcSourceDependencies(text: string, workingDirectory: string): string[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return [];
	}
	if (!isRecord(parsed) || !isRecord(parsed.Data)) {
		return [];
	}
	const data = parsed.Data;
	const source = typeof data.Source === 'string' ? [data.Source] : [];
	const includes = Array.isArray(data.Includes)
		? data.Includes.filter((value): value is string => typeof value === 'string')
		: [];
	return normalizeDependencyPaths([...source, ...includes], workingDirectory);
}

export async function snapshotArtifactInputs(
	sourceFile: string,
	dependencies: readonly string[],
	coverage: ArtifactInputMetadata['dependencyCoverage'],
	workingDirectory: string,
): Promise<ArtifactInputMetadata> {
	const paths = normalizeDependencyPaths(
		[sourceFile, ...(coverage === 'complete' ? dependencies : [])],
		workingDirectory,
	);
	const inputs = await Promise.all(
		paths.map(async (filename) => {
			try {
				const stat = await fs.promises.stat(filename);
				return Object.freeze({
					uri: pathToFileURL(filename).href,
					size: stat.size,
					mtimeMs: stat.mtimeMs,
				});
			} catch {
				// Retaining an unreadable path guarantees that the entry cannot
				// validate as a cache hit later.
				return Object.freeze({
					uri: pathToFileURL(filename).href,
					size: -1,
					mtimeMs: -1,
				});
			}
		}),
	);
	return {
		inputs: Object.freeze(inputs),
		dependencyCoverage: coverage,
	};
}

export async function validateArtifactInputs(inputs: readonly ArtifactInputState[]): Promise<boolean> {
	if (inputs.length === 0) {
		return false;
	}
	return (
		await Promise.all(
			inputs.map(async (input) => {
				try {
					const stat = await fs.promises.stat(fileURLToPath(input.uri));
					return stat.isFile() && stat.size === input.size && stat.mtimeMs === input.mtimeMs;
				} catch {
					return false;
				}
			}),
		)
	).every(Boolean);
}

export function artifactInputComparisonKey(uri: string): string {
	return process.platform === 'win32' ? uri.toLowerCase() : uri;
}

function normalizeDependencyPaths(values: readonly string[], workingDirectory: string): string[] {
	const byKey = new Map<string, string>();
	for (const value of values) {
		const trimmed = value.trim();
		if (!trimmed || trimmed === '\\') {
			continue;
		}
		const absolute = path.normalize(
			isAbsoluteOnAnyPlatform(trimmed) ? trimmed : path.resolve(workingDirectory, trimmed),
		);
		const key = process.platform === 'win32' ? absolute.toLowerCase() : absolute;
		if (!byKey.has(key)) {
			byKey.set(key, absolute);
		}
	}
	return [...byKey.values()].sort((left, right) => {
		const leftKey = process.platform === 'win32' ? left.toLowerCase() : left;
		const rightKey = process.platform === 'win32' ? right.toLowerCase() : right;
		return leftKey.localeCompare(rightKey);
	});
}

function isAbsoluteOnAnyPlatform(value: string): boolean {
	return path.isAbsolute(value) || path.win32.isAbsolute(value);
}

function findRuleSeparator(rule: string): number {
	let tokenStart = 0;
	for (let index = 0; index < rule.length; index++) {
		const character = rule[index];
		if (/\s/.test(character)) {
			tokenStart = index + 1;
			continue;
		}
		if (character !== ':' || isEscaped(rule, index)) {
			continue;
		}
		const driveLetter =
			index === tokenStart + 1 &&
			/[A-Za-z]/.test(rule[tokenStart]) &&
			(rule[index + 1] === '\\' || rule[index + 1] === '/');
		if (!driveLetter) {
			return index;
		}
	}
	return -1;
}

function parseMakeWords(value: string): string[] {
	const result: string[] = [];
	let current = '';
	for (let index = 0; index < value.length; index++) {
		const character = value[index];
		if (/\s/.test(character)) {
			if (current) {
				result.push(current);
				current = '';
			}
			continue;
		}
		if (character === '\\') {
			const next = value[index + 1];
			if (next !== undefined && /[\s#:$\\]/.test(next)) {
				current += next;
				index++;
				continue;
			}
		}
		current += character;
	}
	if (current) {
		result.push(current);
	}
	return result;
}

function isEscaped(value: string, index: number): boolean {
	let slashes = 0;
	for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor--) {
		slashes++;
	}
	return slashes % 2 === 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
