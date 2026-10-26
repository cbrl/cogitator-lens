import { fileURLToPath } from 'node:url';
import type { Uri } from 'vscode';
import type { RawArtifact } from '../types/index.js';
import { artifactInputComparisonKey } from './artifact-inputs.js';
import { localFileUriComparisonKey } from '../file-identity.js';

/** Tool output can reach the output limit of every process, so the cache keeps a budget. */
const defaultMaximumCharacters = 128 * 1024 * 1024;
const defaultMaximumEntries = 256;

/** Raw tool output by production key, evicting the least recently used output over its budget. */
function inputPath(uri: string): string {
	try {
		return fileURLToPath(uri);
	} catch {
		return uri;
	}
}

interface CachedArtifact {
	readonly artifact: RawArtifact;
	readonly source: Uri;
	readonly toolchainProfileId: string;
	/** The identity of each input when the output was stored, by input URI. */
	readonly inputKeys: ReadonlyMap<string, string>;
}

export class RawArtifactCache {
	/** In order of use, least recent first. */
	private readonly entries = new Map<string, CachedArtifact>();
	private readonly inputToKeys = new Map<string, Set<string>>();
	/** A URI of each input, by identity. */
	private readonly inputUris = new Map<string, string>();
	private characters = 0;

	constructor(
		private readonly maximumCharacters = defaultMaximumCharacters,
		private readonly maximumEntries = defaultMaximumEntries,
	) {}

	get(key: string): RawArtifact | undefined {
		const entry = this.entries.get(key);
		if (entry) {
			this.entries.delete(key);
			this.entries.set(key, entry);
		}
		return entry?.artifact;
	}

	get size(): number {
		return this.entries.size;
	}

	/**
	 * Returns the distinct inputs of the cached outputs that `include` accepts for the source of
	 * an output that reads them, by input identity.
	 */
	getInputs(include: (inputPath: string, source: Uri) => boolean = () => true): ReadonlyMap<string, string> {
		const inputs = new Map<string, string>();
		for (const [inputKey, keys] of this.inputToKeys) {
			const uri = this.inputUris.get(inputKey)!;
			const path = inputPath(uri);
			if ([...keys].some((key) => include(path, this.entries.get(key)!.source))) {
				inputs.set(inputKey, uri);
			}
		}
		return inputs;
	}

	/** Stores an output. The newest output stays even when it alone exceeds the budget. */
	set(key: string, artifact: RawArtifact, source: Uri, toolchainProfileId: string): void {
		this.delete(key);
		// Resolving an input's identity reads the filesystem, so it happens once for each output.
		const inputKeys = new Map(artifact.inputs.map((input) => [input.uri, artifactInputComparisonKey(input.uri)]));
		this.entries.set(key, { artifact, source, toolchainProfileId, inputKeys });
		this.characters += artifact.text.length;
		for (const [uri, inputKey] of inputKeys) {
			const keys = this.inputToKeys.get(inputKey) ?? new Set<string>();
			keys.add(key);
			this.inputToKeys.set(inputKey, keys);
			if (!this.inputUris.has(inputKey)) {
				this.inputUris.set(inputKey, uri);
			}
		}
		for (const oldest of this.entries.keys()) {
			if (
				oldest === key ||
				(this.characters <= this.maximumCharacters && this.entries.size <= this.maximumEntries)
			) {
				break;
			}
			this.delete(oldest);
		}
	}

	delete(key: string): void {
		const entry = this.entries.get(key);
		if (!entry) {
			return;
		}
		this.entries.delete(key);
		this.characters -= entry.artifact.text.length;
		for (const inputKey of entry.inputKeys.values()) {
			const keys = this.inputToKeys.get(inputKey);
			keys?.delete(key);
			if (keys?.size === 0) {
				this.inputToKeys.delete(inputKey);
				this.inputUris.delete(inputKey);
			}
		}
	}

	/** Evicts by the identity captured when a watcher was created, including after deletion. */
	evictInputKey(inputKey: string): readonly Uri[] {
		return this.evict([...(this.inputToKeys.get(inputKey) ?? [])]);
	}

	/** Evicts the outputs of the given toolchain profiles and returns their sources. */
	evictToolchains(toolchainProfileIds: ReadonlySet<string>): readonly Uri[] {
		return this.evict(
			[...this.entries].flatMap(([key, entry]) =>
				toolchainProfileIds.has(entry.toolchainProfileId) ? [key] : [],
			),
		);
	}

	private evict(keys: readonly string[]): readonly Uri[] {
		const affectedSources = new Map<string, Uri>();
		for (const key of keys) {
			const source = this.entries.get(key)?.source;
			if (source) {
				affectedSources.set(localFileUriComparisonKey(source), source);
			}
			this.delete(key);
		}
		return [...affectedSources.values()];
	}

	clear(): void {
		this.characters = 0;
		this.entries.clear();
		this.inputToKeys.clear();
		this.inputUris.clear();
	}
}
