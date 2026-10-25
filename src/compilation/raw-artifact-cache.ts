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

export class RawArtifactCache {
	/** In order of use, least recent first. */
	private readonly artifacts = new Map<string, RawArtifact>();
	private readonly inputToKeys = new Map<string, Set<string>>();
	private readonly keyToSource = new Map<string, Uri>();
	private characters = 0;

	constructor(
		private readonly maximumCharacters = defaultMaximumCharacters,
		private readonly maximumEntries = defaultMaximumEntries,
	) {}

	get(key: string): RawArtifact | undefined {
		const artifact = this.artifacts.get(key);
		if (artifact) {
			this.artifacts.delete(key);
			this.artifacts.set(key, artifact);
		}
		return artifact;
	}

	get size(): number {
		return this.artifacts.size;
	}

	/** Returns the distinct inputs of the cached outputs that `include` accepts. */
	getInputUris(include: (inputPath: string, source: Uri) => boolean = () => true): readonly string[] {
		const inputs = new Map<string, string>();
		for (const [key, artifact] of this.artifacts) {
			const source = this.keyToSource.get(key);
			for (const input of artifact.inputs) {
				const inputKey = artifactInputComparisonKey(input.uri);
				if (!inputs.has(inputKey) && source && include(inputPath(input.uri), source)) {
					inputs.set(inputKey, input.uri);
				}
			}
		}
		return [...inputs.values()];
	}

	/** Stores an output. The newest output stays even when it alone exceeds the budget. */
	set(key: string, artifact: RawArtifact, source: Uri): void {
		this.delete(key);
		this.artifacts.set(key, artifact);
		this.characters += artifact.text.length;
		this.keyToSource.set(key, source);
		for (const input of artifact.inputs) {
			const inputKey = artifactInputComparisonKey(input.uri);
			const keys = this.inputToKeys.get(inputKey) ?? new Set<string>();
			keys.add(key);
			this.inputToKeys.set(inputKey, keys);
		}
		for (const oldest of this.artifacts.keys()) {
			if (
				oldest === key ||
				(this.characters <= this.maximumCharacters && this.artifacts.size <= this.maximumEntries)
			) {
				break;
			}
			this.delete(oldest);
		}
	}

	delete(key: string): void {
		const artifact = this.artifacts.get(key);
		if (!artifact) {
			return;
		}
		this.artifacts.delete(key);
		this.characters -= artifact.text.length;
		this.keyToSource.delete(key);
		for (const input of artifact.inputs) {
			const inputKey = artifactInputComparisonKey(input.uri);
			const keys = this.inputToKeys.get(inputKey);
			keys?.delete(key);
			if (keys?.size === 0) {
				this.inputToKeys.delete(inputKey);
			}
		}
	}

	/** Evicts by the identity captured when a watcher was created, including after deletion. */
	evictInputKey(inputKey: string): readonly Uri[] {
		const affectedSources = new Map<string, Uri>();
		for (const key of [...(this.inputToKeys.get(inputKey) ?? [])]) {
			const source = this.keyToSource.get(key);
			if (source) {
				affectedSources.set(localFileUriComparisonKey(source), source);
			}
			this.delete(key);
		}
		return [...affectedSources.values()];
	}

	clear(): void {
		this.characters = 0;
		this.artifacts.clear();
		this.inputToKeys.clear();
		this.keyToSource.clear();
	}
}
