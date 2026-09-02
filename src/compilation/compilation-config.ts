import { Disposable, Event, EventEmitter, Uri } from 'vscode';
import type { CompilationVariant } from '../types/index.js';
import { sourceUriMap, sourceUriSet } from '../uri-containers.js';
import { structurallyEqual } from '../utils.js';

export class CompilationConfigDatabase implements Disposable {
	private readonly bySource = sourceUriMap<Map<string, CompilationVariant>>();
	private readonly selectedVariant = sourceUriMap<string>();
	private readonly changeEmitter = new EventEmitter<readonly Uri[]>();
	private readonly selectionEmitter = new EventEmitter<Uri>();

	readonly onDidChange: Event<readonly Uri[]> = this.changeEmitter.event;
	readonly onDidSelect: Event<Uri> = this.selectionEmitter.event;

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
		const previous = this.selectedVariant.get(source);
		this.selectedVariant.set(source, variantId);
		if (previous !== variantId) {
			this.selectionEmitter.fire(source);
		}
		return true;
	}

	reconcile(provider: string, snapshot: readonly CompilationVariant[]): void {
		const existing = new Map<string, CompilationVariant>();
		for (const [, variants] of this.bySource) {
			for (const variant of variants.values()) {
				if (variant.provider === provider) {
					existing.set(variant.id, variant);
				}
			}
		}

		const incoming = new Map(snapshot.map((variant) => [variant.id, variant]));
		const affected = sourceUriSet();
		let changed = false;

		for (const [id, previous] of existing) {
			const replacement = incoming.get(id);

			if (!replacement) {
				this.bySource.get(previous.source)?.delete(id);
				affected.add(previous.source);
				changed = true;
			} else {
				if (!structurallyEqual(previous, replacement)) {
					this.setVariant(replacement);
					affected.add(replacement.source);
					changed = true;
				}

				incoming.delete(id);
			}
		}

		for (const variant of incoming.values()) {
			this.setVariant(variant);
			affected.add(variant.source);
			changed = true;
		}

		const desiredBySource = sourceUriMap<CompilationVariant[]>();
		for (const variant of snapshot) {
			const desired = desiredBySource.get(variant.source) ?? [];
			desired.push(variant);
			desiredBySource.set(variant.source, desired);
		}
		for (const [source, desired] of desiredBySource) {
			const current = this.bySource.get(source);
			if (!current) {
				continue;
			}
			const reordered = new Map<string, CompilationVariant>();
			let insertedProvider = false;
			for (const variant of current.values()) {
				if (variant.provider === provider) {
					if (!insertedProvider) {
						desired.forEach((item) => reordered.set(item.id, item));
						insertedProvider = true;
					}
				} else {
					reordered.set(variant.id, variant);
				}
			}
			if (!insertedProvider) {
				desired.forEach((item) => reordered.set(item.id, item));
			}
			if (!sameKeyOrder(current, reordered)) {
				this.bySource.set(source, reordered);
				affected.add(source);
				changed = true;
			}
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

		if (changed) {
			this.changeEmitter.fire([...affected.values()]);
		}
	}

	dispose(): void {
		this.changeEmitter.dispose();
		this.selectionEmitter.dispose();
		this.bySource.clear();
		this.selectedVariant.clear();
	}

	private setVariant(variant: CompilationVariant): void {
		const variants = this.bySource.get(variant.source) ?? new Map<string, CompilationVariant>();
		variants.set(variant.id, variant);
		this.bySource.set(variant.source, variants);
	}
}

function sameKeyOrder(
	left: ReadonlyMap<string, CompilationVariant>,
	right: ReadonlyMap<string, CompilationVariant>,
): boolean {
	const leftKeys = [...left.keys()];
	const rightKeys = [...right.keys()];
	return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index]);
}
