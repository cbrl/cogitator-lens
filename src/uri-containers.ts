import vscode from 'vscode';
import { toComparisonKey } from './utils';

type UriComparisonOptions = {
	ignoreFragment?: boolean;
	ignorePathCase?: boolean;
};

export class UriMap<T> {
	private readonly map: Map<string, T> = new Map();

	private readonly ignoreFragment: boolean;
	private readonly ignorePathCase: boolean;

	constructor(options: UriComparisonOptions | undefined = undefined) {
		this.ignoreFragment = options?.ignoreFragment ?? false;
		this.ignorePathCase = options?.ignorePathCase ?? false;
	}

	public get size(): number {
		return this.map.size;
	}

	public set(uri: vscode.Uri, value: T): this {
		this.map.set(this.getKey(uri), value);
		return this;
	}

	public get(uri: vscode.Uri): T | undefined {
		return this.map.get(this.getKey(uri));
	}

	public has(uri: vscode.Uri): boolean {
		return this.map.has(this.getKey(uri));
	}

	public delete(uri: vscode.Uri): boolean {
		return this.map.delete(this.getKey(uri));
	}

	public clear(): void {
		this.map.clear();
	}

	public forEach(callback: (value: T, uri: vscode.Uri, map: UriMap<T>) => void, thisArg?: any): void {
		this.map.forEach((value, key) => callback(value, vscode.Uri.parse(key), thisArg || this));
	}

	public *[Symbol.iterator](): IterableIterator<[vscode.Uri, T]> {
		for (const [key, value] of this.map) {
			yield [vscode.Uri.parse(key), value];
		}
	}

	public keys(): IterableIterator<vscode.Uri> {
		return Array.from(this.map.keys()).map(key => vscode.Uri.parse(key))[Symbol.iterator]();
	}

	public values(): IterableIterator<T> {
		return this.map.values();
	}

	public entries(): IterableIterator<[vscode.Uri, T]> {
		return Array.from(this.map.entries()).map<[vscode.Uri, T]>(([key, value]) => [vscode.Uri.parse(key), value])[Symbol.iterator]();
	}

	private getKey(uri: vscode.Uri): string {
		return toComparisonKey(uri, this.ignoreFragment, this.ignorePathCase);
	}
}

export class UriSet {
	private readonly set: Set<string> = new Set();

	private readonly ignoreFragment: boolean;
	private readonly ignorePathCase: boolean;

	constructor(options: UriComparisonOptions | undefined = undefined) {
		this.ignoreFragment = options?.ignoreFragment ?? false;
		this.ignorePathCase = options?.ignorePathCase ?? false;
	}

	public add(uri: vscode.Uri): this {
		this.set.add(this.getKey(uri));
		return this;
	}

	public has(uri: vscode.Uri): boolean {
		return this.set.has(this.getKey(uri));
	}

	public delete(uri: vscode.Uri): boolean {
		return this.set.delete(this.getKey(uri));
	}

	public clear(): void {
		this.set.clear();
	}

	public forEach(callback: (uri: vscode.Uri, set: UriSet) => void, thisArg?: any): void {
		this.set.forEach(key => callback(vscode.Uri.parse(key), thisArg || this));
	}

	public *[Symbol.iterator](): IterableIterator<vscode.Uri> {
		for (const key of this.set) {
			yield vscode.Uri.parse(key);
		}
	}

	public keys(): IterableIterator<vscode.Uri> {
		return Array.from(this.set).map(key => vscode.Uri.parse(key))[Symbol.iterator]();
	}

	public values(): IterableIterator<vscode.Uri> {
		return this.keys();
	}

	public entries(): IterableIterator<[vscode.Uri, vscode.Uri]> {
		return Array.from(this.set).map<[vscode.Uri, vscode.Uri]>(key => [vscode.Uri.parse(key), vscode.Uri.parse(key)])[Symbol.iterator]();
	}

	private getKey(uri: vscode.Uri): string {
		return toComparisonKey(uri, this.ignoreFragment, this.ignorePathCase);
	}
}