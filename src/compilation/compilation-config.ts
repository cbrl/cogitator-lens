import { Disposable, Event, EventEmitter, Uri } from 'vscode';
import type { CompilationVariant } from '../types/index.js';
import { SourceUriMap, SourceUriSet } from '../file-identity.js';
import { structurallyEqual } from '../utils.js';

/**
 * The compilation variants of every provider, indexed by source.
 *
 * Each provider's last snapshot is the source of truth. The source index is
 * rebuilt from the snapshots in provider order, so the variants of one source
 * keep a stable order across refreshes.
 */
export class CompilationConfigDatabase implements Disposable {
	private readonly byProvider = new Map<string, readonly CompilationVariant[]>();
	private bySource = new SourceUriMap<Map<string, CompilationVariant>>();
	private readonly selectedVariant = new SourceUriMap<string>();
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
		if (structurallyEqual(this.byProvider.get(provider) ?? [], snapshot)) {
			return;
		}
		this.byProvider.set(provider, snapshot);

		const previous = this.bySource;
		this.bySource = new SourceUriMap();
		for (const variant of [...this.byProvider.values()].flat()) {
			const variants = this.bySource.get(variant.source) ?? new Map<string, CompilationVariant>();
			variants.set(variant.id, variant);
			this.bySource.set(variant.source, variants);
		}

		for (const [source, selectedId] of [...this.selectedVariant]) {
			if (!this.bySource.get(source)?.has(selectedId)) {
				this.selectedVariant.delete(source);
			}
		}

		const sources = new SourceUriSet();
		[...previous.keys(), ...this.bySource.keys()].forEach((source) => sources.add(source));
		const changed = [...sources.values()].filter(
			(source) => !sameVariants(previous.get(source), this.bySource.get(source)),
		);
		if (changed.length > 0) {
			this.changeEmitter.fire(changed);
		}
	}

	dispose(): void {
		this.changeEmitter.dispose();
		this.selectionEmitter.dispose();
		this.byProvider.clear();
		this.bySource.clear();
		this.selectedVariant.clear();
	}
}

function sameVariants(
	left: ReadonlyMap<string, CompilationVariant> | undefined,
	right: ReadonlyMap<string, CompilationVariant> | undefined,
): boolean {
	const leftVariants = [...(left?.values() ?? [])];
	const rightVariants = [...(right?.values() ?? [])];
	return (
		leftVariants.length === rightVariants.length &&
		leftVariants.every(
			(variant, index) => variant === rightVariants[index] || structurallyEqual(variant, rightVariants[index]),
		)
	);
}
