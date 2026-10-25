import type { ArtifactKind } from '../types/index.js';

/** The value of one setting in each writable scope, as `inspect` reports them. */
export interface SettingScopes<T> {
	readonly workspaceFolder?: T;
	readonly workspace?: T;
	readonly user?: T;
}

export type SettingScope = keyof SettingScopes<unknown>;

/** Scopes that a setting read without a resource combines, most specific first. */
export const windowScopes: readonly SettingScope[] = ['workspace', 'user'];

/** Scopes that a setting read for a resource combines, most specific first. */
export const resourceScopes: readonly SettingScope[] = ['workspaceFolder', 'workspace', 'user'];

/** The most specific scope whose value `defines` accepts. */
export function definingScope<T>(
	scopes: SettingScopes<T>,
	defines: (value: T) => boolean,
	order: readonly SettingScope[],
): SettingScope | undefined {
	return order.find((scope) => scopes[scope] !== undefined && defines(scopes[scope] as T));
}

/** Whether a scope's `coglens.artifactOptions` value sets an option, by its ID or the ID it replaced. */
export function definesArtifactOption(value: unknown, kind: ArtifactKind, ids: readonly string[]): boolean {
	const options = asRecord(asRecord(value)[kind]);
	return ids.some((id) => typeof options[id] === 'boolean');
}

/** A scope's `coglens.artifactOptions` value with one option set and the IDs it replaced removed. */
export function withArtifactOption(
	value: unknown,
	kind: ArtifactKind,
	id: string,
	enabled: boolean,
	replacedIds: readonly string[] = [],
): Record<string, unknown> {
	const options: Record<string, unknown> = { ...asRecord(asRecord(value)[kind]), [id]: enabled };
	for (const replaced of replacedIds) {
		delete options[replaced];
	}
	return { ...asRecord(value), [kind]: options };
}

/** A copy of a map setting with one entry replaced; the previous key is removed when it is renamed. */
export function withMapEntry(
	value: unknown,
	key: string,
	entry: unknown,
	previousKey?: string,
): Record<string, unknown> {
	const next = { ...asRecord(value) };
	if (previousKey !== undefined) {
		delete next[previousKey];
	}
	next[key] = entry;
	return next;
}

/** A copy of a map setting without one key. */
export function withoutMapEntry(value: unknown, key: string): Record<string, unknown> {
	const next = { ...asRecord(value) };
	delete next[key];
	return next;
}

/** A copy of a list setting with the entry whose `field` matches replaced, or appended when none does. */
export function withListEntry(value: unknown, field: string, entry: Record<string, unknown>): unknown[] {
	const entries = Array.isArray(value) ? [...value] : [];
	const index = entries.findIndex((candidate) => asRecord(candidate)[field] === entry[field]);
	if (index >= 0) {
		entries[index] = entry;
	} else {
		entries.push(entry);
	}
	return entries;
}

/** A copy of a list setting without the entries whose `field` is `key`. */
export function withoutListEntry(value: unknown, field: string, key: string): unknown[] {
	return (Array.isArray(value) ? value : []).filter((candidate) => asRecord(candidate)[field] !== key);
}

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}
