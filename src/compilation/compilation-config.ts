import { Disposable, Event, EventEmitter, Uri } from 'vscode';
import type { CompilationVariant, ReconciliationChange } from '../types/index.js';
import { UriMap } from '../uri-containers.js';

export interface VariantChange extends ReconciliationChange<CompilationVariant> {
	affectedSources: readonly Uri[];
}

export class CompilationConfigDatabase implements Disposable {
	private readonly bySource = new UriMap<Map<string, CompilationVariant>>({
		ignoreFragment: true,
		ignorePathCase: process.platform === 'win32',
	});
	private readonly selectedVariant = new UriMap<string>({
		ignoreFragment: true,
		ignorePathCase: process.platform === 'win32',
	});
	private readonly changeEmitter = new EventEmitter<VariantChange>();

	readonly onDidChange: Event<VariantChange> = this.changeEmitter.event;

	getVariants(source: Uri): readonly CompilationVariant[] {
		return [...(this.bySource.get(source)?.values() ?? [])];
	}

	getAllSources(): readonly Uri[] {
		return [...this.bySource.keys()];
	}

	getSelectedVariant(source: Uri): CompilationVariant | undefined {
		const variants = this.bySource.get(source);
		if (!variants) {
			return undefined;
		}
		const selectedId = this.selectedVariant.get(source);
		return (selectedId ? variants.get(selectedId) : undefined) ?? variants.values().next().value;
	}

	hasSelectedVariant(source: Uri): boolean {
		const selectedId = this.selectedVariant.get(source);
		return selectedId !== undefined && (this.bySource.get(source)?.has(selectedId) ?? false);
	}

	selectVariant(source: Uri, variantId: string): boolean {
		if (!this.bySource.get(source)?.has(variantId)) {
			return false;
		}
		this.selectedVariant.set(source, variantId);
		this.changeEmitter.fire({ added: [], updated: [], removed: [], affectedSources: [source] });
		return true;
	}

	reconcile(provider: string, snapshot: readonly CompilationVariant[]): VariantChange {
		const existing = new Map<string, CompilationVariant>();
		for (const [, variants] of this.bySource) {
			for (const variant of variants.values()) {
				if (variant.provider === provider) {
					existing.set(variant.id, variant);
				}
			}
		}

		const incoming = new Map(snapshot.map(variant => [variant.id, variant]));
		const added: CompilationVariant[] = [];
		const updated: CompilationVariant[] = [];
		const removed: CompilationVariant[] = [];
		const affected = new UriMap<Uri>({ ignoreFragment: true, ignorePathCase: process.platform === 'win32' });

		for (const [id, previous] of existing) {
			const replacement = incoming.get(id);

			if (!replacement) {
				this.bySource.get(previous.source)?.delete(id);
				removed.push(previous);
				affected.set(previous.source, previous.source);
			} else {
				if (JSON.stringify(previous) !== JSON.stringify(replacement)) {
					this.setVariant(replacement);
					updated.push(replacement);
					affected.set(replacement.source, replacement.source);
				}

				incoming.delete(id);
			}
		}

		for (const variant of incoming.values()) {
			this.setVariant(variant);
			added.push(variant);
			affected.set(variant.source, variant.source);
		}

		for (const [source, variants] of [...this.bySource]) {
			if (variants.size === 0) {
				this.bySource.delete(source);
				this.selectedVariant.delete(source);
			} else {
				const selected = this.selectedVariant.get(source);
				if (selected && !variants.has(selected)) {
					this.selectedVariant.delete(source);
				}
			}
		}

		const change = { added, updated, removed, affectedSources: [...affected.values()] };
		if (added.length || updated.length || removed.length) {
			this.changeEmitter.fire(change);
		}

		return change;
	}

	dispose(): void {
		this.changeEmitter.dispose();
		this.bySource.clear();
		this.selectedVariant.clear();
	}

	private setVariant(variant: CompilationVariant): void {
		const variants = this.bySource.get(variant.source) ?? new Map<string, CompilationVariant>();
		variants.set(variant.id, variant);
		this.bySource.set(variant.source, variants);
	}
}
