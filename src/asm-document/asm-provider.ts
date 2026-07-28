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
	TabInputText,
	TextDocument,
	TextDocumentContentProvider,
	Uri,
	window,
	workspace,
} from 'vscode';
import { CompilationService } from '../compilation/index.js';
import type { CompileDiagnostic } from '../types/index.js';
import { equalUri, replaceExtension } from '../utils.js';
import { UriMap, UriSet } from '../uri-containers.js';
import { AsmDecorator } from './asm-decorator.js';
import { CompiledAssembly } from './compiled-assembly.js';
import { CompileHandler } from './compile-handler.js';
import { DecorationStyleManager } from './decorations/decoration-style-manager.js';

export class AsmProvider implements TextDocumentContentProvider, Disposable {
	static readonly scheme = 'assembly';

	private readonly compileHandlers = new UriMap<CompileHandler>();
	private readonly fileWatchers = new UriMap<Disposable>();
	private readonly decorators = new UriMap<AsmDecorator>();
	private readonly compiledAssemblies = new UriMap<CompiledAssembly>();
	private readonly failedCompilations = new UriSet();
	private readonly authorizedDirtyCompilations = new UriSet();
	private readonly sourceToAssembly = new UriMap<Uri>();
	private readonly pendingRefreshes = new UriMap<ReturnType<typeof setTimeout>>();
	private readonly diagnosticUrisBySource = new UriMap<readonly Uri[]>();
	private readonly styleManager = new DecorationStyleManager();
	private readonly changeEmitter = new EventEmitter<Uri>();
	private readonly diagnostics: DiagnosticCollection = languages.createDiagnosticCollection('coglens');
	private readonly subscriptions: Disposable[];

	constructor(private readonly compilationService: CompilationService) {
		this.subscriptions = [
			workspace.onDidCloseTextDocument(document => this.onCloseTextDocument(document)),
			compilationService.onVariantsChanged(sources => {
				for (const source of sources) {
					const assembly = this.sourceToAssembly.get(source);
					if (assembly) {
						this.requestRefresh(assembly);
					}
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
		if (!this.decorators.has(handler.srcUri)) {
			this.decorators.set(
				handler.srcUri,
				new AsmDecorator(handler.srcUri, handler.asmUri, handler.onDidChange, this.styleManager),
			);
		}

		const compilation = handler.update(token);
		window.setStatusBarMessage(`$(sync~spin) Compiling ${handler.srcUri.path.split('/').at(-1) ?? 'source'}`, compilation);

		return compilation.then(({ assembly, artifact }) => {
			this.compiledAssemblies.set(uri, assembly);
			this.failedCompilations.delete(handler.srcUri);
			this.authorizedDirtyCompilations.delete(handler.srcUri);
			this.setDiagnostics(artifact.diagnostics, handler.srcUri);

			return assembly.getContent();
		}).catch((error: unknown) => {
			this.compiledAssemblies.delete(uri);
			if (error instanceof CancellationError || token.isCancellationRequested) {
				return this.compiledAssemblies.get(uri)?.getContent() ?? '';
			}

			this.failedCompilations.add(handler.srcUri);
			this.authorizedDirtyCompilations.delete(handler.srcUri);
			const diagnostics = (error as { diagnostics?: readonly CompileDiagnostic[] }).diagnostics ?? [];
			this.setDiagnostics(diagnostics, handler.srcUri);

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

		const sourceUri = Uri.parse(assemblyUri.query);
		handler = new CompileHandler(sourceUri, assemblyUri, this.compilationService);
		this.sourceToAssembly.set(sourceUri, assemblyUri);
		const compileSubscription = handler.onDidChange(result => {
			if (result instanceof CompiledAssembly) {
				this.compiledAssemblies.set(assemblyUri, result);
			} else {
				this.compiledAssemblies.delete(assemblyUri);
			}
		});

		const watcher = workspace.createFileSystemWatcher(sourceUri.fsPath);
		const watcherSubscription = watcher.onDidChange(() => this.requestRefresh(assemblyUri));
		this.fileWatchers.set(assemblyUri, Disposable.from(watcher, watcherSubscription, compileSubscription));
		this.compileHandlers.set(assemblyUri, handler);

		return handler;
	}

	private setDiagnostics(items: readonly CompileDiagnostic[], fallbackSource: Uri): void {
		for (const uri of this.diagnosticUrisBySource.get(fallbackSource) ?? []) {
			this.diagnostics.delete(uri);
		}

		const grouped = new Map<string, { uri: Uri; diagnostics: Diagnostic[] }>();
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

		const diagnosticUris: Uri[] = [];
		for (const group of grouped.values()) {
			this.diagnostics.set(group.uri, group.diagnostics);
			diagnosticUris.push(group.uri);
		}

		this.diagnosticUrisBySource.set(fallbackSource, diagnosticUris);
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
			this.decorators.get(handler.srcUri)?.dispose();
			this.decorators.delete(handler.srcUri);
			this.failedCompilations.delete(handler.srcUri);
			this.authorizedDirtyCompilations.delete(handler.srcUri);
			this.sourceToAssembly.delete(handler.srcUri);
			handler.dispose();
			this.compileHandlers.delete(uri);
		}

		this.fileWatchers.get(uri)?.dispose();
		this.fileWatchers.delete(uri);
		this.compiledAssemblies.delete(uri);
	}
}

export function getAsmUri(source: Uri): Uri {
	return source.with({
		scheme: AsmProvider.scheme,
		path: replaceExtension(source.path, '.asm'),
		query: source.toString(),
	});
}

function toDiagnosticSeverity(severity: CompileDiagnostic['severity']): DiagnosticSeverity {
	switch (severity) {
		case 'warning': return DiagnosticSeverity.Warning;
		case 'information': return DiagnosticSeverity.Information;
		default: return DiagnosticSeverity.Error;
	}
}
