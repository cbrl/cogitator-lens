import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import { ArtifactDocumentProvider } from '../../src/artifact-document/artifact-document-provider.js';
import { ArtifactDocumentRegistry } from '../../src/artifact-document/artifact-document-registry.js';
import { getArtifactUri } from '../../src/artifact-document/artifact-uri.js';
import type { ArtifactPreset } from '../../src/artifacts/ui/presets.js';
import {
	commonComparisonKinds,
	compatibleComparisonTargets,
	comparisonTargets,
	comparisonUri,
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

/**
 * Opens text artifacts through the document provider with a fake compiler. The Problems view must
 * show a diagnostic once, and a failure must keep the last listing or show the compiler output.
 */
export async function verifyArtifactDocumentDiagnostics(repositoryRoot: string): Promise<void> {
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
	const variantWith = (args: readonly string[]): CompilationVariant => ({
		id: variantId,
		provider: 'cmake',
		source,
		toolchainProfileId: profile.id,
		workingDirectory: directory,
		arguments: args,
		environment: {},
		displayLabel: 'Fake documents',
	});
	const presets: ArtifactPreset[] = [
		{ id: 'second', artifactKind: 'assembly', extraArguments: ['-DSECOND'], productionOptions: {} },
	];
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
	} as unknown as ConfigurationService;
	const service = new CompilationService(configuration);
	const registry = new ArtifactDocumentRegistry(service, configuration);
	const provider = new ArtifactDocumentProvider(service, configuration, registry);
	const cancellation = new vscode.CancellationTokenSource();
	const provide = async (uri: vscode.Uri): Promise<string> =>
		(await provider.provideTextDocumentContent(uri, cancellation.token)) ?? '';
	const reported = (): vscode.Diagnostic[] =>
		vscode.languages.getDiagnostics(source).filter((diagnostic) => diagnostic.source === 'Cogitator Lens');
	try {
		service.reconcileProviderSnapshot({
			provider: 'cmake',
			toolchainProfiles: [profile],
			variants: [variantWith(['--warn'])],
		});
		const defaultUri = getArtifactUri(source, { id: variantId }, 'assembly', 'default');
		const secondUri = getArtifactUri(source, { id: variantId }, 'assembly', 'second');
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
		service.reconcileProviderSnapshot({
			provider: 'cmake',
			toolchainProfiles: [profile],
			variants: [variantWith(['--fail'])],
		});
		assert.equal(await provide(defaultUri), listing);
		assert.equal(provider.getArtifactDocumentState(defaultUri)?.status.state, 'failed');
		const errors = reported().filter((diagnostic) => diagnostic.severity === vscode.DiagnosticSeverity.Error);
		assert.deepEqual(
			errors.map((diagnostic) => diagnostic.message),
			['expected fake failure'],
		);

		// A failure without an earlier listing shows the compiler output instead.
		const stackUri = getArtifactUri(source, { id: variantId }, 'stack-analysis', 'default');
		assert.match(await provide(stackUri), /expected fake failure/u);
		assert.equal(provider.getArtifactDocumentState(stackUri)?.status.state, 'failed');
		assert.equal(
			reported().filter((diagnostic) => diagnostic.severity === vscode.DiagnosticSeverity.Error).length,
			1,
		);
	} finally {
		cancellation.dispose();
		provider.dispose();
		registry.dispose();
		service.dispose();
		changes.dispose();
		await fs.promises.rm(directory, { recursive: true, force: true });
	}
	assert.equal(reported().length, 0, 'Closing the artifacts removes their diagnostics');
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
