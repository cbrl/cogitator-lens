import { pathToFileURL } from 'node:url';
import type { Uri } from 'vscode';
import type { RawArtifact } from '../types/index.js';
import { artifactInputComparisonKey } from './artifact-inputs.js';

export class RawArtifactCache {
	private readonly artifacts = new Map<string, RawArtifact>();
	private readonly inputToKeys = new Map<string, Set<string>>();
	private readonly keyToSource = new Map<string, Uri>();

	get(key: string): RawArtifact | undefined {
		return this.artifacts.get(key);
	}

	getInputUris(): readonly string[] {
		const inputs = new Map<string, string>();
		for (const artifact of this.artifacts.values()) {
			for (const input of artifact.inputs) {
				const key = artifactInputComparisonKey(input.uri);
				if (!inputs.has(key)) {
					inputs.set(key, input.uri);
				}
			}
		}
		return [...inputs.values()];
	}

	set(key: string, artifact: RawArtifact, source: Uri): void {
		this.delete(key);
		this.artifacts.set(key, artifact);
		this.keyToSource.set(key, source);
		for (const input of artifact.inputs) {
			const inputKey = artifactInputComparisonKey(input.uri);
			const keys = this.inputToKeys.get(inputKey) ?? new Set<string>();
			keys.add(key);
			this.inputToKeys.set(inputKey, keys);
		}
	}

	delete(key: string): void {
		const artifact = this.artifacts.get(key);
		if (!artifact) {
			return;
		}
		this.artifacts.delete(key);
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

	evictInput(uri: Uri): readonly Uri[] {
		const inputKey = artifactInputComparisonKey(pathToFileURL(uri.fsPath).href);
		const affectedSources = new Map<string, Uri>();
		for (const key of [...(this.inputToKeys.get(inputKey) ?? [])]) {
			const source = this.keyToSource.get(key);
			if (source) {
				affectedSources.set(source.toString(), source);
			}
			this.delete(key);
		}
		return [...affectedSources.values()];
	}

	clear(): void {
		this.artifacts.clear();
		this.inputToKeys.clear();
		this.keyToSource.clear();
	}
}
