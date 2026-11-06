import { Disposable, EventEmitter, type Event, type Memento, type Uri } from 'vscode';
import { uriComparisonKey } from '../file-identity.js';

/** The workspace state key of the edited arguments. */
const stateKey = 'coglens.artifactArguments';
/** The number of documents whose arguments are kept. The oldest edit goes first. */
const maximumEntries = 200;

/**
 * The compiler arguments that the user added to one artifact document. They follow the variant and
 * preset arguments, and they belong to the document URI, so the tab stays when they change.
 */
export class ArtifactArguments implements Disposable {
	private readonly entries: Map<string, readonly string[]>;
	private readonly changeEmitter = new EventEmitter<Uri>();

	/** Fires with the document URI after its arguments change. */
	readonly onDidChange: Event<Uri> = this.changeEmitter.event;

	constructor(private readonly state?: Memento) {
		const stored = state?.get<Record<string, unknown>>(stateKey) ?? {};
		this.entries = new Map(
			Object.entries(stored).flatMap(([key, value]) =>
				Array.isArray(value) && value.every((argument) => typeof argument === 'string')
					? [[key, Object.freeze([...(value as string[])])] as const]
					: [],
			),
		);
	}

	get(uri: Uri): readonly string[] {
		return this.entries.get(uriComparisonKey(uri)) ?? [];
	}

	/** Sets the arguments of a document. An empty list removes the entry. */
	async set(uri: Uri, args: readonly string[]): Promise<void> {
		const key = uriComparisonKey(uri);
		const previous = this.entries.get(key) ?? [];
		if (previous.length === args.length && previous.every((argument, index) => argument === args[index])) {
			return;
		}
		this.entries.delete(key);
		if (args.length > 0) {
			this.entries.set(key, Object.freeze([...args]));
		}
		while (this.entries.size > maximumEntries) {
			this.entries.delete(this.entries.keys().next().value!);
		}
		this.changeEmitter.fire(uri);
		await this.state?.update(stateKey, Object.fromEntries(this.entries));
	}

	dispose(): void {
		this.changeEmitter.dispose();
	}
}
