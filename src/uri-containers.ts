import vscode from 'vscode';
import { toComparisonKey } from './utils.js';
import { localFileUriComparisonKey } from './local-file-identity.js';

type UriComparisonOptions = {
	ignoreFragment?: boolean;
	ignorePathCase?: boolean;
	physicalFileIdentity?: boolean;
};

/**
 * A map that uses URIs as keys, using proper comparison and allowing for flexible comparison options.
 * Keeps each key's original Uri alongside its comparison-key string, so iteration returns the Uri as
 * it was stored rather than one reconstructed from a (possibly lowercased) comparison key.
 */
export class UriMap<T> {
	private readonly map = new Map<string, T>();
	private readonly originalUris = new Map<string, vscode.Uri>();

	private readonly ignoreFragment: boolean;
	private readonly ignorePathCase: boolean;
	private readonly physicalFileIdentity: boolean;

	constructor(options: UriComparisonOptions | undefined = undefined) {
		this.ignoreFragment = options?.ignoreFragment ?? false;
		this.ignorePathCase = options?.ignorePathCase ?? false;
		this.physicalFileIdentity = options?.physicalFileIdentity ?? false;
	}

	public get size(): number {
		return this.map.size;
	}

	public set(uri: vscode.Uri, value: T): this {
		const key = this.getKey(uri);
		this.map.set(key, value);
		this.originalUris.set(key, uri);
		return this;
	}

	public get(uri: vscode.Uri): T | undefined {
		return this.map.get(this.getKey(uri));
	}

	public has(uri: vscode.Uri): boolean {
		return this.map.has(this.getKey(uri));
	}

	public delete(uri: vscode.Uri): boolean {
		const key = this.getKey(uri);
		this.originalUris.delete(key);
		return this.map.delete(key);
	}

	public clear(): void {
		this.map.clear();
		this.originalUris.clear();
	}

	public *[Symbol.iterator](): IterableIterator<[vscode.Uri, T]> {
		for (const [key, value] of this.map) {
			yield [this.originalUris.get(key)!, value];
		}
	}

	public keys(): IterableIterator<vscode.Uri> {
		return this.originalUris.values();
	}

	private getKey(uri: vscode.Uri): string {
		if (this.physicalFileIdentity) {
			return sourceUriComparisonKey(uri);
		}
		return toComparisonKey(uri, this.ignoreFragment, this.ignorePathCase);
	}
}

/**
 * A set that uses URIs as keys, using proper comparison and allowing for flexible comparison options.
 * Keeps each member's original Uri alongside its comparison-key string, so `values()` returns the Uri
 * as it was added rather than one reconstructed from a (possibly lowercased) comparison key.
 */
export class UriSet {
	private readonly set = new Set<string>();
	private readonly originalUris = new Map<string, vscode.Uri>();

	private readonly ignoreFragment: boolean;
	private readonly ignorePathCase: boolean;
	private readonly physicalFileIdentity: boolean;

	constructor(options: UriComparisonOptions | undefined = undefined) {
		this.ignoreFragment = options?.ignoreFragment ?? false;
		this.ignorePathCase = options?.ignorePathCase ?? false;
		this.physicalFileIdentity = options?.physicalFileIdentity ?? false;
	}

	public get size(): number {
		return this.set.size;
	}

	public add(uri: vscode.Uri): this {
		const key = this.getKey(uri);
		this.set.add(key);
		this.originalUris.set(key, uri);
		return this;
	}

	public has(uri: vscode.Uri): boolean {
		return this.set.has(this.getKey(uri));
	}

	public delete(uri: vscode.Uri): boolean {
		const key = this.getKey(uri);
		this.originalUris.delete(key);
		return this.set.delete(key);
	}

	public values(): IterableIterator<vscode.Uri> {
		return this.originalUris.values();
	}

	private getKey(uri: vscode.Uri): string {
		if (this.physicalFileIdentity) {
			return sourceUriComparisonKey(uri);
		}
		return toComparisonKey(uri, this.ignoreFragment, this.ignorePathCase);
	}
}

const sourceIdentityOptions = {
	ignoreFragment: true,
	ignorePathCase: process.platform === 'win32',
	physicalFileIdentity: true,
} as const;

/** Comparison key for source URIs, resolving local paths through symlinks. */
export function sourceUriComparisonKey(uri: vscode.Uri): string {
	return uri.scheme === 'file'
		? localFileUriComparisonKey(uri)
		: toComparisonKey(uri, true, process.platform === 'win32');
}

export function sourceUriMap<T>(): UriMap<T> {
	return new UriMap<T>(sourceIdentityOptions);
}

export function sourceUriSet(): UriSet {
	return new UriSet(sourceIdentityOptions);
}
