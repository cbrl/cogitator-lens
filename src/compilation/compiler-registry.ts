import { Disposable, Event, EventEmitter } from 'vscode';
import type { ICompilerRegistry } from '../interfaces/index.js';
import type { CompilerProfile, ReconciliationChange } from '../types/index.js';
import { CompilerBase } from '../compiler.js';
import { getCompilerByType } from '../compilers/compiler-map.js';

export type ConfigurationOrigin = 'user' | 'cmake' | 'compilation-database' | string;

interface RegistryEntry {
	origin: ConfigurationOrigin;
	profile: CompilerProfile;
	compiler: CompilerBase;
}

export class CompilerRegistry implements ICompilerRegistry, Disposable {
	private readonly entries = new Map<string, RegistryEntry>();
	private readonly changeEmitter = new EventEmitter<ReconciliationChange<CompilerProfile>>();

	readonly onDidChange: Event<ReconciliationChange<CompilerProfile>> = this.changeEmitter.event;

	getProfiles(origin?: ConfigurationOrigin): readonly CompilerProfile[] {
		return [...this.entries.values()]
			.filter(entry => origin === undefined || entry.origin === origin)
			.map(entry => entry.profile);
	}

	getCompilerById(id: string): CompilerBase | undefined {
		return this.entries.get(id)?.compiler;
	}

	findCompilerByDisplayName(displayName: string): CompilerBase | undefined {
		return [...this.entries.values()]
			.find(entry => entry.profile.displayName === displayName)
			?.compiler;
	}

	getOrigin(id: string): ConfigurationOrigin | undefined {
		return this.entries.get(id)?.origin;
	}

	reconcile(origin: ConfigurationOrigin, profiles: readonly CompilerProfile[]): ReconciliationChange<CompilerProfile> {
		const next = new Map(profiles.map(profile => [profile.id, profile]));
		const added: CompilerProfile[] = [];
		const updated: CompilerProfile[] = [];
		const removed: CompilerProfile[] = [];

		for (const [id, entry] of this.entries) {
			if (entry.origin !== origin) {
				continue;
			}
			const replacement = next.get(id);
			if (!replacement) {
				this.entries.delete(id);
				removed.push(entry.profile);
			} else if (!profilesEqual(entry.profile, replacement)) {
				this.entries.set(id, this.createEntry(origin, replacement));
				updated.push(replacement);
			}
			next.delete(id);
		}

		for (const profile of next.values()) {
			const existing = this.entries.get(profile.id);
			if (existing && existing.origin !== origin) {
				throw new Error(`Compiler profile ID "${profile.id}" is already owned by ${existing.origin}`);
			}
			this.entries.set(profile.id, this.createEntry(origin, profile));
			added.push(profile);
		}

		const change = { added, updated, removed };
		if (added.length || updated.length || removed.length) {
			this.changeEmitter.fire(change);
		}
		return change;
	}

	dispose(): void {
		this.changeEmitter.dispose();
		this.entries.clear();
	}

	private createEntry(origin: ConfigurationOrigin, profile: CompilerProfile): RegistryEntry {
		const Adapter = getCompilerByType(profile.kind);
		if (!Adapter) {
			throw new Error(`Unsupported compiler kind: ${profile.kind}`);
		}
		return { origin, profile, compiler: new Adapter(profile) };
	}
}

function profilesEqual(left: CompilerProfile, right: CompilerProfile): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}
