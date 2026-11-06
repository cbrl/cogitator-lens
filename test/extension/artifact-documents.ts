import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import { ActiveArtifact, type GraphPanelFocus } from '../../src/artifact-document/active-artifact.js';
import { ArtifactDocumentProvider } from '../../src/artifact-document/artifact-document-provider.js';
import { ArtifactDocumentRegistry } from '../../src/artifact-document/artifact-document-registry.js';
import { getArtifactUri, parseArtifactUri } from '../../src/artifact-document/artifact-uri.js';
import { currentListing } from '../../src/artifact-document/artifact-generator.js';
import { toolchainComparisonVariantId } from '../../src/compilation/comparison-variants.js';
import type { ArtifactPreset } from '../../src/artifacts/ui/presets.js';
import {
	commonComparisonKinds,
	compatibleComparisonTargets,
	comparisonTargets,
	comparisonUri,
	openArtifactArguments,
	type ArtifactAvailabilityLookup,
} from '../../src/commands/artifacts.js';
import { CompilationService } from '../../src/compilation/compilation-service.js';
import type { ConfigurationService, SettingsChange } from '../../src/services/configuration-service.js';
import {
	defaultArtifactOptions,
	type ArtifactKind,
	type CompilationVariant,
	type ToolchainProfile,
} from '../../src/types/index.js';

/** Artifact document names keep forward slashes, and their languages do not claim user files. */
export async function verifyArtifactDocumentNames(): Promise<void> {
	const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'coglens-names-'));
	try {
		const source = vscode.Uri.file(path.join(directory, 'main.cpp'));
		const variant = { id: 'names' };
		const assembly = getArtifactUri(source, variant, 'assembly', 'default');
		assert.equal(assembly.path.includes('\\'), false, assembly.path);
		assert.equal(path.posix.dirname(assembly.path), path.posix.dirname(source.path));
		assert.equal(path.posix.basename(assembly.path), 'main.coglens.asm');
		assert.equal(
			path.posix.basename(getArtifactUri(source, variant, 'preprocessed-source', 'default').path),
			'main.preprocessed.cpp',
		);

		const languageOf = async (filename: string): Promise<string> => {
			const file = path.join(directory, filename);
			await fs.promises.writeFile(file, '');
			return (await vscode.workspace.openTextDocument(vscode.Uri.file(file))).languageId;
		};
		for (const filename of ['user.asm', 'user.ll', 'user.ast', 'user.mir']) {
			assert.equal((await languageOf(filename)).startsWith('coglens-'), false, filename);
		}
		assert.equal(await languageOf('artifact.coglens.asm'), 'coglens-asm');
		assert.equal(await languageOf('artifact.coglens.disasm'), 'coglens-asm');
		assert.equal(await languageOf('artifact.coglens.ll'), 'coglens-llvm-ir');

		// The tab shows the artifact file name. The variant is unknown, so the document shows a failure.
		const editor = await vscode.window.showTextDocument(assembly, { preview: false });
		try {
			assert.equal(editor.document.languageId, 'coglens-asm');
			const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
			assert.equal(tab?.label, 'main.coglens.asm');
		} finally {
			await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
		}
	} finally {
		await fs.promises.rm(directory, { recursive: true, force: true });
	}
}

/** A document provider of its own, with a fake compiler and a variant whose arguments a test sets. */
interface DocumentEnvironment {
	readonly source: vscode.Uri;
	readonly service: CompilationService;
	readonly registry: ArtifactDocumentRegistry;
	readonly provider: ArtifactDocumentProvider;
	/** The URI of an assembly document of the fake variant with a preset. */
	uri(preset?: string, kind?: ArtifactKind): vscode.Uri;
	/** Sets the arguments of the fake variant. */
	compileWith(args: readonly string[]): void;
	/** Announces a change to the settings with these keys. */
	changeSettings(...keys: string[]): void;
	provide(uri: vscode.Uri): Promise<string>;
}

async function withDocumentEnvironment(
	repositoryRoot: string,
	test: (environment: DocumentEnvironment) => Promise<void>,
): Promise<void> {
	const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'coglens-documents-'));
	const source = vscode.Uri.file(path.join(directory, 'main.cpp'));
	await fs.promises.writeFile(source.fsPath, 'int main() { return 0; }\n');
	const profile: ToolchainProfile = {
		id: 'fake-documents-gcc',
		displayName: 'Fake documents GCC',
		kind: 'gcc',
		executable: 'node',
		defaultArguments: [path.join(repositoryRoot, 'test/fixtures/stack-analysis/fake-compiler.cjs')],
		environment: {},
		tools: {},
	};
	const variantId = 'fake:documents';
	const presets: ArtifactPreset[] = ['second', 'third', 'fourth'].map((id) => ({
		id,
		artifactKind: 'assembly',
		extraArguments: [`-D${id.toUpperCase()}`],
		productionOptions: {},
	}));
	const changes = new vscode.EventEmitter<SettingsChange>();
	const configuration = {
		onDidChange: changes.event,
		getToolchains: () => [],
		getArtifactOptions: () => defaultArtifactOptions,
		getArtifactPresets: () => presets,
		getDefaultCompilationSettings: () => undefined,
		getManualCompilationVariants: () => [],
		getDimUnusedSourceLines: () => false,
		getSynchronizeSourceAndArtifactScrolling: () => false,
		getOptimizationRemarkCategories: () => new Set(['passed', 'missed', 'analysis']),
	} as unknown as ConfigurationService;
	const service = new CompilationService(configuration);
	const registry = new ArtifactDocumentRegistry(service, configuration);
	const provider = new ArtifactDocumentProvider(service, configuration, registry);
	const cancellation = new vscode.CancellationTokenSource();
	try {
		await test({
			source,
			service,
			registry,
			provider,
			uri: (preset = 'default', kind = 'assembly') => getArtifactUri(source, { id: variantId }, kind, preset),
			compileWith: (args) =>
				service.reconcileProviderSnapshot({
					provider: 'cmake',
					toolchainProfiles: [profile],
					variants: [
						{
							id: variantId,
							provider: 'cmake',
							source,
							toolchainProfileId: profile.id,
							workingDirectory: directory,
							arguments: args,
							environment: {},
							displayLabel: 'Fake documents',
						},
					],
				}),
			changeSettings: (...keys) => changes.fire({ affects: (key) => keys.includes(key) }),
			provide: async (uri) => (await provider.provideTextDocumentContent(uri, cancellation.token)) ?? '',
		});
	} finally {
		cancellation.dispose();
		provider.dispose();
		registry.dispose();
		service.dispose();
		changes.dispose();
		// On Windows, VS Code watches the folder of a file that an editor showed. It stops a moment after
		// the editor closes, and until then the folder cannot be removed.
		await fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
}

/**
 * Opens text artifacts through the document provider with a fake compiler. The Problems view must
 * show a diagnostic once, and a failure must keep the last listing or show the compiler output.
 */
export async function verifyArtifactDocumentDiagnostics(repositoryRoot: string): Promise<void> {
	let source: vscode.Uri | undefined;
	const reported = (): vscode.Diagnostic[] =>
		source
			? vscode.languages.getDiagnostics(source).filter((diagnostic) => diagnostic.source === 'Cogitator Lens')
			: [];
	await withDocumentEnvironment(repositoryRoot, async ({ provider, uri, compileWith, provide, ...environment }) => {
		source = environment.source;
		compileWith(['--warn']);
		const defaultUri = uri();
		const secondUri = uri('second');
		const listing = await provide(defaultUri);
		await provide(secondUri);
		assert.equal(provider.getArtifactDocumentState(defaultUri)?.status.state, 'successful');
		assert.equal(provider.getArtifactDocumentState(secondUri)?.status.state, 'successful');

		// Both artifacts report the same warning, and the Problems view shows it once.
		const [warning, ...others] = reported();
		assert.equal(others.length, 0);
		assert.equal(warning?.message, 'expected fake warning');
		assert.equal(warning.severity, vscode.DiagnosticSeverity.Warning);
		assert.ok(warning.range.isEmpty, 'An empty range lets the editor underline the whole word');
		assert.deepEqual([warning.range.start.line, warning.range.start.character], [0, 4]);

		// A failure after a success keeps the last listing and reports the compiler error.
		compileWith(['--fail']);
		assert.equal(await provide(defaultUri), listing);
		assert.equal(provider.getArtifactDocumentState(defaultUri)?.status.state, 'failed');
		const errors = reported().filter((diagnostic) => diagnostic.severity === vscode.DiagnosticSeverity.Error);
		assert.deepEqual(
			errors.map((diagnostic) => diagnostic.message),
			['expected fake failure'],
		);

		// A failure without an earlier listing shows the compiler output instead.
		const stackUri = uri('default', 'stack-analysis');
		assert.match(await provide(stackUri), /expected fake failure/u);
		assert.equal(provider.getArtifactDocumentState(stackUri)?.status.state, 'failed');
		assert.equal(
			reported().filter((diagnostic) => diagnostic.severity === vscode.DiagnosticSeverity.Error).length,
			1,
		);
	});
	assert.equal(reported().length, 0, 'Closing the artifacts removes their diagnostics');
}

/**
 * A slow first compile opens with a placeholder, and its result follows as a change. The next
 * content request collects the result without a compile. A fast compile shows no placeholder.
 */
export async function verifyArtifactDocumentPlaceholder(repositoryRoot: string): Promise<void> {
	await withDocumentEnvironment(repositoryRoot, async ({ provider, registry, uri, compileWith, provide }) => {
		compileWith(['--delay=1500']);
		const slowUri = uri();
		const changed = nextChange(provider, slowUri);
		assert.equal(await provide(slowUri), 'Compiling main.cpp with Fake documents GCC…');
		assert.equal(provider.getArtifactDocumentState(slowUri)?.status.state, 'compiling');
		await changed;
		const generatedAt = provider.getRenderedArtifact(slowUri)?.generatedAt;
		assert.equal(await provide(slowUri), 'object');
		assert.equal(provider.getRenderedArtifact(slowUri)?.generatedAt, generatedAt, 'No second compile');

		// A cache hit shows the listing at once.
		registry.unregister(slowUri);
		assert.equal(await provide(slowUri), 'object');

		// A cancelled first compile replaces the placeholder with a notice.
		const cancelledUri = uri('second');
		const cancelled = nextChange(provider, cancelledUri);
		assert.match(await provide(cancelledUri), /^Compiling main\.cpp/u);
		assert.equal(registry.document(cancelledUri)?.handler.cancel(), true);
		await cancelled;
		assert.match(await provide(cancelledUri), /^Generation was cancelled\. Run "Refresh Artifact"/u);
		assert.equal(provider.getArtifactDocumentState(cancelledUri)?.status.state, 'cancelled');

		// A refresh of a document that shows a listing keeps the listing until the result.
		compileWith(['--delay=400']);
		const refreshed = provide(slowUri);
		assert.equal(await refreshed, 'object');

		// An empty listing explains itself.
		compileWith(['--empty']);
		const emptyUri = uri('third');
		assert.match(await provide(emptyUri), /^The compiler made no Assembly output for main\.cpp\./u);
		assert.equal(provider.getArtifactDocumentState(emptyUri)?.status.state, 'successful');
	});
}

/**
 * The parsers read the listing line limit when they read the raw output. So a new limit renders the
 * open listings again, and the cached output means that no compile starts.
 */
export async function verifyListingLineLimitRefresh(repositoryRoot: string): Promise<void> {
	await withDocumentEnvironment(repositoryRoot, async ({ provider, uri, compileWith, changeSettings, provide }) => {
		compileWith([]);
		const listingUri = uri();
		assert.equal(await provide(listingUri), 'object');
		const before = provider.getRenderedArtifact(listingUri);
		assert.ok(before);

		const changed = nextChange(provider, listingUri);
		changeSettings('listingLineLimit');
		await changed;
		assert.equal(await provide(listingUri), 'object');
		const after = provider.getRenderedArtifact(listingUri);
		assert.notEqual(after, before, 'The listing renders again');
		assert.equal(after?.generatedAt, before.generatedAt, 'The render uses the cached output');
	});
}

/**
 * The provider forgets a document when its last tab closes, and a stand-in artifact follows the
 * focused source. The tabs show the extension's own documents, which have the same URIs.
 */
export async function verifyArtifactDocumentTabs(repositoryRoot: string): Promise<void> {
	await withDocumentEnvironment(repositoryRoot, async ({ source, registry, provider, uri, compileWith, provide }) => {
		compileWith([]);
		const artifactUri = uri('fourth');
		await provide(artifactUri);
		assert.ok(registry.document(artifactUri));

		const panelsChanged = new vscode.EventEmitter<void>();
		const graphs: GraphPanelFocus = {
			activeDocument: undefined,
			visibleDocuments: () => [],
			onDidChangePanels: panelsChanged.event,
		};
		const active = new ActiveArtifact(registry, graphs);
		// A call is not narrowed by an assertion before it, as a property read is.
		const activeUri = (): string | undefined => active.document?.uri.toString();
		try {
			await vscode.window.showTextDocument(source, { viewColumn: vscode.ViewColumn.One, preview: false });
			assert.equal(activeUri(), undefined, 'No artifact of the source is visible');
			await vscode.window.showTextDocument(artifactUri, {
				viewColumn: vscode.ViewColumn.Two,
				preserveFocus: true,
				preview: false,
			});
			assert.equal(vscode.window.activeTextEditor?.document.uri.fsPath, source.fsPath);
			assert.equal(activeUri(), artifactUri.toString(), 'The visible artifact stands in');

			await vscode.commands.executeCommand('workbench.action.closeAllEditors');
			await waitFor(() => registry.document(artifactUri) === undefined, 'The closed tab removes the document');
			assert.equal(activeUri(), undefined);

			// VS Code keeps the document of a closed tab for a while. A reopened tab uses it without a
			// content request, so the provider announces a change, which makes VS Code request the content.
			assert.ok(
				vscode.workspace.textDocuments.some((document) => document.uri.toString() === artifactUri.toString()),
			);
			const reopened = nextChange(provider, artifactUri);
			await vscode.window.showTextDocument(artifactUri, { preview: false });
			await reopened;
			assert.equal(await provide(artifactUri), 'object');
			assert.ok(registry.document(artifactUri));
		} finally {
			active.dispose();
			panelsChanged.dispose();
			await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		}
	});
}

/** Open Artifact reads a kind and a preset from a key binding, and refuses others. */
export function verifyOpenArtifactArguments(): void {
	assert.deepEqual(openArtifactArguments(undefined), {});
	assert.deepEqual(openArtifactArguments({ kind: 'llvm-ir' }), { kind: 'llvm-ir' });
	assert.deepEqual(openArtifactArguments({ kind: 'assembly', preset: 'fast' }), {
		kind: 'assembly',
		preset: 'fast',
	});
	assert.deepEqual(openArtifactArguments({ preset: 'fast' }), { preset: 'fast' });
	assert.equal(openArtifactArguments({ kind: 'machine-code' }), undefined);
	assert.equal(openArtifactArguments({ kind: 'assembly', preset: 3 }), undefined);
}

function nextChange(provider: ArtifactDocumentProvider, uri: vscode.Uri): Promise<void> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			subscription.dispose();
			reject(new Error(`No change for ${uri.toString()}`));
		}, 20_000);
		const subscription = provider.onDidChange((changed) => {
			if (changed.toString() === uri.toString()) {
				clearTimeout(timeout);
				subscription.dispose();
				resolve();
			}
		});
	});
}

async function waitFor(condition: () => boolean, message: string): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (!condition()) {
		assert.ok(Date.now() < deadline, message);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

/** Comparison offers variants and presets, keeps only compatible pairs, and never diffs graphs. */
export function verifyComparisonTargets(): void {
	const source = vscode.Uri.file(path.join(os.tmpdir(), 'coglens-compare', 'main.cpp'));
	const variant = (name: string): CompilationVariant => ({
		id: `cmake:${name}`,
		provider: 'cmake',
		source,
		toolchainProfileId: `cmake:${name}`,
		workingDirectory: path.dirname(source.fsPath),
		arguments: [],
		environment: {},
		displayLabel: name,
	});
	const preset = (id: string, artifactKind: ArtifactKind): ArtifactPreset => ({
		id,
		artifactKind,
		extraArguments: [],
		productionOptions: {},
	});
	const gcc = variant('gcc');
	const clang = variant('clang');
	// GCC has no LLVM IR in this registry, and neither toolchain has Rust MIR.
	const registry: ArtifactAvailabilityLookup = {
		getArtifactAvailability: (id, kind) =>
			kind === 'rust-mir' || (kind === 'llvm-ir' && id === gcc.toolchainProfileId)
				? { status: 'unsupported', explanation: 'unsupported' }
				: { status: 'available' },
	};
	const targets = comparisonTargets(
		[gcc, clang],
		[preset('fast', 'assembly'), preset('ir', 'llvm-ir'), preset('graph', 'control-flow-graph')],
		gcc,
	);
	assert.deepEqual(
		targets.map((target) => target.id),
		['variant:cmake:gcc', 'variant:cmake:clang', 'preset:fast', 'preset:ir', 'preset:graph'],
	);
	const byId = new Map(targets.map((target) => [target.id, target]));
	const target = (id: string) => {
		const found = byId.get(id);
		assert.ok(found, id);
		return found;
	};

	// The IR preset applies to the selected GCC variant, which has no LLVM IR.
	assert.deepEqual(
		compatibleComparisonTargets(target('preset:fast'), targets, registry).map((candidate) => candidate.id),
		['variant:cmake:gcc', 'variant:cmake:clang'],
	);
	assert.deepEqual(compatibleComparisonTargets(target('preset:ir'), targets, registry), []);

	const variants = commonComparisonKinds(target('variant:cmake:gcc'), target('variant:cmake:clang'), registry);
	assert.equal(variants.textKinds.includes('assembly'), true);
	assert.equal(variants.textKinds.includes('llvm-ir'), false);
	assert.equal(variants.textKinds.includes('control-flow-graph'), false);
	assert.equal(variants.hasGraphKind, true);
	assert.deepEqual(commonComparisonKinds(target('preset:fast'), target('variant:cmake:clang'), registry), {
		textKinds: ['assembly'],
		hasGraphKind: false,
	});
	assert.deepEqual(commonComparisonKinds(target('preset:graph'), target('variant:cmake:clang'), registry), {
		textKinds: [],
		hasGraphKind: true,
	});

	// A preset of the selected variant and the variant itself are different artifacts.
	assert.notEqual(
		comparisonUri(source, target('preset:fast'), 'assembly').toString(),
		comparisonUri(source, target('variant:cmake:gcc'), 'assembly').toString(),
	);
}

/**
 * Edited arguments refresh one document and follow its preset arguments. The document keeps the
 * listing before the last change, a view URI shows a part of the listing, and a comparison variant
 * of the same toolchain resolves with the arguments of its base variant.
 */
export async function verifyArtifactExperiments(repositoryRoot: string): Promise<void> {
	await withDocumentEnvironment(
		repositoryRoot,
		async ({ provider, registry, service, source, uri, compileWith, provide }) => {
			compileWith(['--warn']);
			const defaultUri = uri();
			assert.equal(await provide(defaultUri), 'object');
			const handler = registry.document(defaultUri)?.handler;
			assert.ok(handler);
			assert.equal(handler.previousText, undefined);

			// An edit refreshes the same document. Its arguments come last.
			let changed = nextChange(provider, defaultUri);
			await registry.editedArguments.set(defaultUri, ['--empty']);
			await changed;
			await provide(defaultUri);
			const args = handler.status.invocation?.args ?? [];
			assert.ok(args.indexOf('--empty') > args.indexOf('--warn'), args.join(' '));
			assert.equal(handler.status.artifact?.presentation, 'text');
			assert.equal(handler.previousText, 'object');

			// Another document of the source keeps its own arguments.
			const secondUri = uri('second');
			assert.equal(await provide(secondUri), 'object');
			const secondArgs = registry.document(secondUri)?.handler.status.invocation?.args ?? [];
			assert.equal(secondArgs.includes('--empty'), false);
			assert.equal(secondArgs.includes('-DSECOND'), true);

			// A refresh with the same text keeps the earlier listing.
			changed = nextChange(provider, defaultUri);
			registry.requestRefresh(defaultUri);
			await changed;
			await provide(defaultUri);
			assert.equal(handler.previousText, 'object');

			// Removing the edit compiles the full listing again, and the empty listing becomes the earlier one.
			changed = nextChange(provider, defaultUri);
			await registry.editedArguments.set(defaultUri, []);
			await changed;
			assert.equal(await provide(defaultUri), 'object');
			assert.equal(handler.previousText, '');

			// A failed compile keeps the listing for its own document. The source features do not use it,
			// because the source can have changed since the listing compiled.
			changed = nextChange(provider, defaultUri);
			await registry.editedArguments.set(defaultUri, ['--fail']);
			await changed;
			assert.equal(await provide(defaultUri), 'object');
			assert.equal(handler.status.state, 'failed');
			assert.equal(handler.status.artifact?.presentation, 'text');
			assert.equal(currentListing(handler.status), undefined);
			changed = nextChange(provider, defaultUri);
			await registry.editedArguments.set(defaultUri, []);
			await changed;
			await provide(defaultUri);
			assert.equal(currentListing(handler.status)?.lines[0]?.text, 'object');

			// A view URI keeps its view, and a function that the listing does not have gives a notice.
			const viewUri = getArtifactUri(source, { id: 'fake:documents' }, 'assembly', 'default', undefined, {
				normalized: true,
				functionName: 'main',
			});
			assert.deepEqual(parseArtifactUri(viewUri)?.view, { normalized: true, functionName: 'main' });
			assert.equal(parseArtifactUri(defaultUri)?.view, undefined);
			assert.equal(await provide(viewUri), 'The function "main" is not in this listing.');
			assert.throws(() =>
				getArtifactUri(source, { id: 'fake:documents' }, 'control-flow-graph', 'default', 'assembly', {
					normalized: true,
				}),
			);

			// A comparison variant names its toolchain and the variant whose settings it uses.
			const toolchainId = registry.document(defaultUri)?.identity.toolchainId ?? '';
			const comparison = service.findVariant(source, toolchainComparisonVariantId(toolchainId, 'fake:documents'));
			assert.equal(comparison?.toolchainProfileId, toolchainId);
			assert.deepEqual(comparison?.arguments, service.findVariant(source, 'fake:documents')?.arguments);
			assert.equal(
				service.findVariant(source, toolchainComparisonVariantId('missing', 'fake:documents')),
				undefined,
			);
		},
	);
}
