import {
	CancellationError,
	CancellationToken,
	Diagnostic,
	DiagnosticCollection,
	DiagnosticSeverity,
	Disposable,
	Event,
	EventEmitter,
	languages,
	Position,
	ProviderResult,
	Range,
	RelativePattern,
	TabInputText,
	TextDocument,
	TextDocumentContentProvider,
	Uri,
	window,
	workspace,
} from 'vscode';
import path from 'path';
import { CompilationService } from '../compilation/index.js';
import type { IConfigurationService } from '../interfaces/index.js';
import { CompilationError, type CompileDiagnostic } from '../types/index.js';
import { equalUri } from '../utils.js';
import { UriMap, UriSet } from '../uri-containers.js';
import { assemblyScheme, getAsmUri, parseAsmUri } from './asm-uri.js';
import { AsmDecorator } from './asm-decorator.js';
import { CompiledAssembly } from './compiled-assembly.js';
import { CompileHandler } from './compile-handler.js';
import { DecorationStyleManager } from './decorations/decoration-style-manager.js';

const uriComparisonOptions = {
	ignoreFragment: true,
	ignorePathCase: process.platform === 'win32',
} as const;

export class AsmProvider implements TextDocumentContentProvider, Disposable {
	static readonly scheme = assemblyScheme;

	private readonly compileHandlers = new UriMap<CompileHandler>(uriComparisonOptions);
	private readonly fileWatchers = new UriMap<Disposable>(uriComparisonOptions);
	private readonly decorators = new UriMap<AsmDecorator>(uriComparisonOptions);
	private readonly compiledAssemblies = new UriMap<CompiledAssembly>(uriComparisonOptions);
	private readonly authorizedDirtyCompilations = new UriSet(uriComparisonOptions);
	private readonly sourceToAssembly = new UriMap<UriSet>(uriComparisonOptions);
	private readonly pendingRefreshes = new UriMap<ReturnType<typeof setTimeout>>(uriComparisonOptions);
	private readonly diagnosticsByAssembly = new UriMap<readonly CompileDiagnostic[]>(uriComparisonOptions);
	private readonly styleManager = new DecorationStyleManager();
	private readonly changeEmitter = new EventEmitter<Uri>();
	private readonly diagnostics: DiagnosticCollection = languages.createDiagnosticCollection('coglens');
	private readonly subscriptions: Disposable[];

	constructor(
		private readonly compilationService: CompilationService,
		private readonly configuration: IConfigurationService,
	) {
		this.subscriptions = [
			workspace.onDidCloseTextDocument(document => this.onCloseTextDocument(document)),
			compilationService.onVariantsChanged(sources => {
				for (const source of sources) {
					for (const assembly of this.sourceToAssembly.get(source)?.values() ?? []) {
						this.requestRefresh(assembly);
					}
				}
			}),
			compilationService.onFiltersChanged(() => {
				for (const handler of this.compileHandlers.values()) {
					this.requestRefresh(handler.asmUri);
				}
			}),
			this.changeEmitter,
			this.diagnostics,
		];
	}

	// Implements TextDocumentContentProvider.provideTextDocumentContent. This function will be called for the given
	// Uri when onDidChange(Uri) is fired. onDidChange will be fired when a source document changes and is recompiled
	// (or fails to recompile).
	provideTextDocumentContent(uri: Uri, token: CancellationToken): ProviderResult<string> {
		const handler = this.getCompileHandler(uri);
		const sourceDocument = workspace.textDocuments.find(document =>
			equalUri(document.uri, handler.srcUri, true, process.platform === 'win32')
		);

		if (sourceDocument?.isDirty && !this.authorizedDirtyCompilations.has(handler.srcUri)) {
			return this.compiledAssemblies.get(uri)?.getContent()
				?? 'Source has unsaved changes. Run “Disassemble Current File” to choose which version to compile.';
		}
		if (!this.decorators.has(uri)) {
			this.decorators.set(
				uri,
				new AsmDecorator(
					handler.srcUri,
					handler.asmUri,
					handler.onDidChange,
					this.styleManager,
					this.configuration,
				),
			);
		}

		const compilation = handler.update(token);
		window.setStatusBarMessage(`$(sync~spin) Compiling ${handler.srcUri.path.split('/').at(-1) ?? 'source'}`, compilation);

		return compilation.then(({ assembly, artifact }) => {
			this.compiledAssemblies.set(uri, assembly);
			this.authorizedDirtyCompilations.delete(handler.srcUri);
			this.setDiagnostics(uri, artifact.diagnostics);

			return assembly.getContent();
		}).catch((error: unknown) => {
			if (error instanceof CancellationError || token.isCancellationRequested) {
				return this.compiledAssemblies.get(uri)?.getContent() ?? '';
			}

			this.compiledAssemblies.delete(uri);
			this.authorizedDirtyCompilations.delete(handler.srcUri);
			const diagnostics = error instanceof CompilationError ? error.diagnostics : [];
			this.setDiagnostics(uri, diagnostics);

			return error instanceof Error ? error.message : String(error);
		});
	}

	get onDidChange(): Event<Uri> {
		return this.changeEmitter.event;
	}

	getCompiledAssembly(uri: Uri): CompiledAssembly | undefined {
		return this.compiledAssemblies.get(uri);
	}

	requestRefresh(assemblyUri: Uri): void {
		const previous = this.pendingRefreshes.get(assemblyUri);
		if (previous) {
			clearTimeout(previous);
		}

		const timer = setTimeout(() => {
			this.pendingRefreshes.delete(assemblyUri);
			this.changeEmitter.fire(assemblyUri);
		}, 50);
		this.pendingRefreshes.set(assemblyUri, timer);
	}

	allowDirtySavedCompilation(sourceUri: Uri): void {
		this.authorizedDirtyCompilations.add(sourceUri);
	}

	dispose(): void {
		this.subscriptions.forEach(subscription => subscription.dispose());
		this.pendingRefreshes.forEach(timer => clearTimeout(timer));
		this.fileWatchers.forEach(disposable => disposable.dispose());
		this.decorators.forEach(decorator => decorator.dispose());
		this.compileHandlers.forEach(handler => handler.dispose());
		this.styleManager.dispose();
		this.compileHandlers.clear();
	}

	private getCompileHandler(assemblyUri: Uri): CompileHandler {
		let handler = this.compileHandlers.get(assemblyUri);
		if (handler) {
			return handler;
		}

		const identity = parseAsmUri(assemblyUri);
		const variant = this.compilationService.getVariants(identity.source)
			.find(candidate => candidate.id === identity.variantId);
		if (!variant) {
			throw new CompilationError(`Compilation variant is no longer available: ${identity.variantId}`);
		}
		handler = new CompileHandler(
			identity.source,
			assemblyUri,
			variant,
			identity.outputMode,
			this.compilationService,
		);
		let assemblyUris = this.sourceToAssembly.get(identity.source);
		if (!assemblyUris) {
			assemblyUris = new UriSet(uriComparisonOptions);
			this.sourceToAssembly.set(identity.source, assemblyUris);
		}
		assemblyUris.add(assemblyUri);
		const compileSubscription = handler.onDidChange(result => {
			if (result instanceof CompiledAssembly) {
				this.compiledAssemblies.set(assemblyUri, result);
			} else {
				this.compiledAssemblies.delete(assemblyUri);
			}
		});

		const watcher = workspace.createFileSystemWatcher(new RelativePattern(
			Uri.file(path.dirname(identity.source.fsPath)),
			path.basename(identity.source.fsPath),
		));
		const watcherSubscription = watcher.onDidChange(() => this.requestRefresh(assemblyUri));
		this.fileWatchers.set(assemblyUri, Disposable.from(watcher, watcherSubscription, compileSubscription));
		this.compileHandlers.set(assemblyUri, handler);

		return handler;
	}

	private setDiagnostics(assemblyUri: Uri, items: readonly CompileDiagnostic[]): void {
		this.diagnosticsByAssembly.set(assemblyUri, items);
		this.rebuildDiagnostics();
	}

	private onCloseTextDocument(document: TextDocument): void {
		if (!this.compileHandlers.has(document.uri)) {
			return;
		}

		// Guard against race condition: if the user reopens the same assembly document quickly,
		// the delayed close event from the old document would destroy the new handler/decorator.
		// Only clean up if no tab still shows this document.
		const remainsOpen = window.tabGroups.all.some(group => group.tabs.some(tab =>
			tab.input instanceof TabInputText && tab.input.uri.toString() === document.uri.toString()));

		if (!remainsOpen) {
			this.unregisterDocument(document.uri);
		}
	}

	private unregisterDocument(uri: Uri): void {
		const handler = this.compileHandlers.get(uri);
		if (handler) {
			this.decorators.get(uri)?.dispose();
			this.decorators.delete(uri);
			this.authorizedDirtyCompilations.delete(handler.srcUri);
			const assemblyUris = this.sourceToAssembly.get(handler.srcUri);
			assemblyUris?.delete(uri);
			if (assemblyUris?.size === 0) {
				this.sourceToAssembly.delete(handler.srcUri);
			}
			this.diagnosticsByAssembly.delete(uri);
			this.rebuildDiagnostics();
			handler.dispose();
			this.compileHandlers.delete(uri);
		}

		this.fileWatchers.get(uri)?.dispose();
		this.fileWatchers.delete(uri);
		this.compiledAssemblies.delete(uri);
	}

	private rebuildDiagnostics(): void {
		this.diagnostics.clear();
		const grouped = new Map<string, { uri: Uri; diagnostics: Diagnostic[] }>();
		for (const items of this.diagnosticsByAssembly.values()) {
			for (const item of items) {
				const key = item.uri.toString();
				const group = grouped.get(key) ?? { uri: item.uri, diagnostics: [] };
				group.diagnostics.push(new Diagnostic(
					new Range(new Position(item.line, item.column), new Position(item.line, item.column + 1)),
					item.message,
					toDiagnosticSeverity(item.severity),
				));
				grouped.set(key, group);
			}
		}
		for (const group of grouped.values()) {
			this.diagnostics.set(group.uri, group.diagnostics);
		}
	}
}

export { getAsmUri, parseAsmUri } from './asm-uri.js';

function toDiagnosticSeverity(severity: CompileDiagnostic['severity']): DiagnosticSeverity {
	switch (severity) {
		case 'warning': return DiagnosticSeverity.Warning;
		case 'information': return DiagnosticSeverity.Information;
		default: return DiagnosticSeverity.Error;
	}
}
