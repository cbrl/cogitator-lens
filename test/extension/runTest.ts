import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as vscode from 'vscode';
import type { PythonExtension, ResolvedEnvironment } from '@vscode/python-extension';
import { CompilationDatabaseVariantProvider } from '../../src/buildsystems/compilation-database.js';
import { PythonEnvironmentVariantProvider } from '../../src/buildsystems/python-environments.js';
import { CompilationConfigDatabase } from '../../src/compilation/compilation-config.js';
import { ToolchainRegistry } from '../../src/compilation/toolchain-registry.js';
import {
	CompilationError,
	defaultArtifactOptions,
	type ArtifactRequest,
	type CompilationVariant,
	type RenderedTextArtifact,
	type ToolchainProfile,
} from '../../src/types/index.js';
import { sourceUriMap } from '../../src/uri-containers.js';
import { parseToolDiagnostics } from '../../src/diagnostics.js';
import { CompilationService } from '../../src/compilation/compilation-service.js';
import type { ConfigurationService } from '../../src/services/configuration-service.js';
import {
	buildCompilationInfoTree,
	type CompilationInfoTreeNode,
	CompilationInfoTreeProvider,
} from '../../src/tree/compilation-info-tree.js';
import { buildToolchainTreeNode, type ToolchainTreeNode } from '../../src/tree/toolchain-tree.js';
import { getArtifactUri, parseArtifactUri } from '../../src/artifact-document/artifact-uri.js';
import { ArtifactGenerator } from '../../src/artifact-document/artifact-generator.js';
import { buildArtifactOptionsTree, type GlobalOptionsNode } from '../../src/tree/global-options-tree.js';
import { buildArtifactPresetTreeNode, type ArtifactPresetTreeNode } from '../../src/tree/artifact-presets-tree.js';
import { ArtifactNavigationProvider } from '../../src/artifact-document/artifact-navigation-provider.js';
import { ArtifactDetailsTreeProvider } from '../../src/tree/artifact-details-tree.js';
import type { ArtifactDocumentSnapshot } from '../../src/artifact-document/artifact-identity.js';
import type { ArtifactDocumentProvider } from '../../src/artifact-document/artifact-document-provider.js';
import { MissingToolOutputError, ToolchainBackend, ToolExitError } from '../../src/toolchains/toolchain-backend.js';
import { toolchainDefinitions } from '../../src/toolchains/toolchain-map.js';
import {
	clangClStackUsageOutput,
	nativeStackUsageOutput,
} from '../../src/artifacts/stack-analysis/native-stack-analysis.js';
import { ExecError } from '../../src/exec.js';
import { isSupportedSourceDocument } from '../../src/commands/artifacts.js';

const extensionToolchainHost = {
	log() {},
	parseDiagnostics: parseToolDiagnostics,
};

export async function run(): Promise<void> {
	const extension = vscode.extensions.getExtension('cbrl.coglens');
	assert.ok(extension, 'Cogitator Lens extension was not discovered');
	await extension.activate();

	// Every command the manifest contributes must actually be registered, so neither
	// list has to be repeated here.
	const registeredCommands = new Set(await vscode.commands.getCommands(true));
	const contributedCommands = (
		JSON.parse(fs.readFileSync(path.join(extension.extensionPath, 'package.json'), 'utf8')) as {
			contributes: { commands: Array<{ command: string }> };
		}
	).contributes.commands;
	assert.ok(contributedCommands.length > 0);
	for (const { command } of contributedCommands) {
		assert.ok(registeredCommands.has(command), `Contributed command is not registered: ${command}`);
	}
	await verifyAdditionalSourceLanguageIds();

	const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
	assert.ok(workspaceFolder, 'Extension tests require an open workspace folder');
	const configuration = vscode.workspace.getConfiguration('coglens', workspaceFolder.uri);
	const previousFilters = configuration.inspect('artifactOptions')?.workspaceFolderValue;
	try {
		const filters = { assembly: { labels: false, directives: true } };
		await configuration.update('artifactOptions', filters, vscode.ConfigurationTarget.WorkspaceFolder);
		assert.deepEqual(configuration.inspect('artifactOptions')?.workspaceFolderValue, filters);
	} finally {
		await configuration.update('artifactOptions', previousFilters, vscode.ConfigurationTarget.WorkspaceFolder);
	}

	verifyRegistryReconciliation();
	verifyVariantSnapshots();
	verifyUriMapping();
	verifyDiagnostics(workspaceFolder);
	await verifyFilterChangeSignal();
	verifyManualVariantConfiguration(workspaceFolder);
	verifyAssemblyUriRoundTrip();
	verifyArtifactNavigationProviders();
	await verifyDisplayFilterCaching(workspaceFolder);
	await verifyMissingSourceIsUnavailable(workspaceFolder);
	await verifyArtifactGeneratorStates(workspaceFolder);
	await verifyNativeStackProduction(workspaceFolder);
	await verifyArtifactDetailsTree(workspaceFolder);
	await verifyCompilationDatabaseVariantProvider(workspaceFolder);
	await verifyPythonEnvironmentVariantProvider(workspaceFolder);
	verifyTreeModels(workspaceFolder);
}

async function verifyAdditionalSourceLanguageIds(): Promise<void> {
	const repositoryRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
	assert.ok(repositoryRoot);
	const zigDocument = await vscode.workspace.openTextDocument(
		vscode.Uri.joinPath(repositoryRoot, 'samples', 'zig', 'src', 'main.zig'),
	);
	assert.equal(zigDocument.languageId, 'zig');
	assert.equal(isSupportedSourceDocument(zigDocument), true);

	const cudaDocument = await vscode.workspace.openTextDocument(
		vscode.Uri.joinPath(repositoryRoot, 'samples', 'cuda', 'src', 'main.cu'),
	);
	assert.equal(cudaDocument.languageId, 'cuda-cpp');
	assert.equal(isSupportedSourceDocument(cudaDocument), true);
}

async function verifyCompilationDatabaseVariantProvider(workspaceFolder: vscode.WorkspaceFolder): Promise<void> {
	const temporaryDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'coglens-compdb-'));
	const databasePath = path.join(temporaryDirectory, 'compile_commands.json');
	const source = vscode.Uri.file(path.join(temporaryDirectory, 'main.cpp'));
	const workspaceConfiguration = vscode.workspace.getConfiguration('coglens', workspaceFolder.uri);
	const previousDatabases = workspaceConfiguration.inspect('compilationDatabases')?.workspaceFolderValue;
	const configurationChange = new vscode.EventEmitter<void>();
	const configuration = testConfiguration(configurationChange, {
		getCompilationDatabases: (scope?: vscode.Uri) =>
			vscode.workspace.getConfiguration('coglens', scope).get<string[]>('compilationDatabases', []),
	});
	const service = new CompilationService(configuration);
	const monitor = new CompilationDatabaseVariantProvider(configuration);
	const monitorSubscription = monitor.onSnapshot((snapshot) => service.reconcileProviderSnapshot(snapshot));

	try {
		await fs.promises.writeFile(
			databasePath,
			JSON.stringify([
				{
					directory: temporaryDirectory,
					file: source.fsPath,
					arguments: ['g++', '-O2', '-c', source.fsPath, '-o', 'main.o'],
					output: 'main.o',
				},
			]),
			'utf8',
		);
		await workspaceConfiguration.update(
			'compilationDatabases',
			[databasePath],
			vscode.ConfigurationTarget.WorkspaceFolder,
		);

		const cmakeProfile = toolchainProfile('cmake:gcc', '-O0');
		service.reconcileProviderSnapshot({
			provider: 'cmake',
			toolchainProfiles: [cmakeProfile],
			variants: [
				{
					...compilationVariant('cmake:main', source, 'CMake'),
					toolchainProfileId: cmakeProfile.id,
				},
			],
		});

		await monitor.initialize();
		const providers = service
			.getVariants(source)
			.map((variant) => variant.provider)
			.sort();
		assert.deepEqual(
			providers,
			['cmake', 'compilation-database'],
			'CMake and compilation database variants should coexist for one source',
		);
		const databaseVariant = service
			.getVariants(source)
			.find((variant) => variant.provider === 'compilation-database');
		assert.ok(databaseVariant);
		assert.deepEqual(databaseVariant.arguments, ['-O2', '-c', '-o', 'main.o']);
		assert.equal(databaseVariant.workingDirectory, temporaryDirectory);

		await fs.promises.rm(databasePath);
		await monitor.refresh();
		assert.deepEqual(
			service.getVariants(source).map((variant) => variant.provider),
			['cmake'],
			'Deleting a database should remove only that provider snapshot',
		);
	} finally {
		monitorSubscription.dispose();
		monitor.dispose();
		service.dispose();
		configurationChange.dispose();
		await workspaceConfiguration.update(
			'compilationDatabases',
			previousDatabases,
			vscode.ConfigurationTarget.WorkspaceFolder,
		);
		await fs.promises.rm(temporaryDirectory, { recursive: true, force: true });
	}
}

async function verifyPythonEnvironmentVariantProvider(workspaceFolder: vscode.WorkspaceFolder): Promise<void> {
	const executable = vscode.Uri.file(path.join(workspaceFolder.uri.fsPath, '.venv', 'python.exe'));
	const environment: ResolvedEnvironment = {
		id: 'test-environment',
		path: path.dirname(executable.fsPath),
		executable: {
			uri: executable,
			bitness: '64-bit',
			sysPrefix: path.dirname(executable.fsPath),
		},
		environment: {
			type: 'VirtualEnvironment',
			name: '.venv',
			folderUri: vscode.Uri.file(path.dirname(executable.fsPath)),
			workspaceFolder,
		},
		version: {
			major: 3,
			minor: 13,
			micro: 5,
			release: { level: 'final', serial: 0 },
			sysVersion: '3.13.5',
		},
		tools: ['Venv'],
	};
	const environmentChanges = new vscode.EventEmitter<never>();
	const activeChanges = new vscode.EventEmitter<never>();
	const variableChanges = new vscode.EventEmitter<never>();
	let refreshes = 0;
	const api = {
		ready: Promise.resolve(),
		environments: {
			known: [environment],
			getActiveEnvironmentPath: () => ({ id: environment.id, path: environment.path }),
			onDidChangeEnvironments: environmentChanges.event,
			onDidChangeActiveEnvironmentPath: activeChanges.event,
			onDidEnvironmentVariablesChange: variableChanges.event,
			refreshEnvironments: async () => {
				refreshes++;
			},
			resolveEnvironment: async () => environment,
			getEnvironmentVariables: () => ({ PYTHONPATH: workspaceFolder.uri.fsPath }),
		},
	} as unknown as PythonExtension;
	const provider = new PythonEnvironmentVariantProvider(async () => api);
	let snapshot: import('../../src/types/index.js').ProviderSnapshot | undefined;
	const subscription = provider.onSnapshot((value) => {
		snapshot = value;
	});

	try {
		await provider.initialize();
		assert.equal(refreshes, 1);
		assert.ok(snapshot);
		assert.equal(snapshot.provider, 'python-environments');
		assert.equal(snapshot.toolchainProfiles.length, 1);
		assert.equal(snapshot.toolchainProfiles[0].executable, executable.fsPath);
		const fixture = snapshot.variants.find((variant) =>
			variant.source.fsPath.endsWith(path.join('test', 'fixtures', 'python', 'source-mapping.py')),
		);
		assert.ok(fixture, 'Python environment discovery should create variants for workspace Python files');
		assert.equal(fixture.toolchainProfileId, snapshot.toolchainProfiles[0].id);
		assert.equal(fixture.environment.PYTHONPATH, workspaceFolder.uri.fsPath);
		assert.equal(fixture.target, 'Bytecode');
	} finally {
		subscription.dispose();
		provider.dispose();
		environmentChanges.dispose();
		activeChanges.dispose();
		variableChanges.dispose();
	}
}

async function verifyArtifactGeneratorStates(workspaceFolder: vscode.WorkspaceFolder): Promise<void> {
	const source = vscode.Uri.joinPath(workspaceFolder.uri, 'state-test.cpp');
	const variant = compilationVariant('state:test', source, 'State test');
	const assemblyUri = getArtifactUri(source, variant, 'assembly', 'default');
	let fail = false;
	let waitForCancellation = false;
	let lastRequest: ArtifactRequest | undefined;
	const compilationService = {
		getArtifactOptions: () => defaultArtifactOptions,
		getArtifactPreset: () => ({
			id: 'default',
			artifactKind: 'assembly',
			extraArguments: ['--preset-argument'],
			productionOptions: { intel: true },
		}),
		toolchainRegistry: {
			getToolchainById: () => ({
				profile: toolchainProfile(variant.toolchainProfileId, '-O2'),
			}),
		},
		compile: async (request: ArtifactRequest) => {
			lastRequest = request;
			if (fail) {
				request.onInvocation?.({
					executable: 'fake-compiler',
					args: ['--expected-failure'],
					cwd: workspaceFolder.uri.fsPath,
					environmentVariableNames: ['PATH'],
				});
				throw new CompilationError('expected failure');
			}
			if (waitForCancellation) {
				await new Promise<never>((_resolve, reject) => {
					if (request.cancellationToken.isCancellationRequested) {
						reject(new vscode.CancellationError());
						return;
					}
					const subscription = request.cancellationToken.onCancellationRequested(() => {
						subscription.dispose();
						reject(new vscode.CancellationError());
					});
				});
			}
			return {
				status: 'available',
				artifact: {
					kind: 'assembly',
					presentation: 'text',
					text: 'ret',
					lines: [{ text: 'ret' }],
					sourceLocations: [],
					links: [],
					folds: [],
					symbols: [],
					metrics: {},
					raw: 'ret',
					diagnostics: [],
					durationMs: 1,
					generatedAt: 0,
					command: {
						executable: process.execPath,
						args: [],
						environmentVariableNames: [],
						cwd: workspaceFolder.uri.fsPath,
					},
					truncated: false,
					toolOutputTruncated: false,
				},
			};
		},
	} as unknown as CompilationService;
	const handler = new ArtifactGenerator(source, assemblyUri, variant, 'assembly', 'default', compilationService);
	const states: string[] = [handler.status.state];
	const subscription = handler.onDidChange((status) => states.push(status.state));
	const cancellation = new vscode.CancellationTokenSource();
	try {
		await handler.update(cancellation.token);
		assert.deepEqual(lastRequest?.extraArguments, ['--preset-argument']);
		assert.equal(lastRequest?.options.production.intel, true);
		handler.markStale();
		fail = true;
		await assert.rejects(handler.update(cancellation.token), CompilationError);
		assert.equal(handler.status.invocation?.executable, 'fake-compiler');
		fail = false;
		waitForCancellation = true;
		const cancelledUpdate = handler.update(cancellation.token);
		await Promise.resolve();
		assert.equal(handler.cancel(), true);
		assert.equal(handler.cancel(), true);
		await assert.rejects(cancelledUpdate, vscode.CancellationError);
		assert.equal(handler.status.state, 'cancelled');
		assert.equal(handler.cancel(), false);
		assert.deepEqual(states, [
			'stale',
			'compiling',
			'successful',
			'stale',
			'compiling',
			'compiling',
			'failed',
			'compiling',
			'cancelled',
		]);
	} finally {
		cancellation.dispose();
		subscription.dispose();
		handler.dispose();
	}
}

function verifyAssemblyUriRoundTrip(): void {
	const source = vscode.Uri.file('/project/path with spaces/main.cpp');
	const uri = getArtifactUri(
		source,
		{
			id: 'cmake:app:Debug/x64',
		},
		'assembly',
		'default',
	);
	const identity = parseArtifactUri(uri);
	assert.ok(identity);
	assert.equal(identity.source.toString(), source.toString());
	assert.equal(identity.variantId, 'cmake:app:Debug/x64');
	assert.equal(identity.artifactKind, 'assembly');
	assert.equal(identity.presetId, 'default');
	assert.match(uri.path, /main\.asm$/);
	const presetUri = getArtifactUri(
		source,
		{
			id: 'cmake:app:Debug/x64',
		},
		'assembly',
		'optimized',
	);
	assert.notEqual(uri.toString(), presetUri.toString());
	assert.equal(parseArtifactUri(presetUri)?.presetId, 'optimized');
	const graphUri = getArtifactUri(
		source,
		{
			id: 'cmake:app:Debug/x64',
		},
		'control-flow-graph',
		'default',
		'assembly',
	);
	assert.throws(
		() => getArtifactUri(source, { id: 'cmake:app:Debug/x64' }, 'control-flow-graph', 'default'),
		/output selection/u,
	);
	assert.equal(parseArtifactUri(graphUri)?.artifactOutputId, 'assembly');
	const graphWithoutOutput = graphUri.with({
		query: new URLSearchParams(
			[...new URLSearchParams(graphUri.query).entries()].filter(([name]) => name !== 'output'),
		).toString(),
	});
	assert.equal(parseArtifactUri(graphWithoutOutput), undefined);
	assert.notEqual(
		graphUri.toString(),
		getArtifactUri(source, { id: 'cmake:app:Debug/x64' }, 'control-flow-graph', 'default', 'llvm-ir').toString(),
	);
	const remarksUri = getArtifactUri(
		source,
		{
			id: 'cmake:app:Debug/x64',
		},
		'optimization-remarks',
		'default',
	);
	assert.match(remarksUri.path, /main\.opt\.cpp$/);
	assert.equal(parseArtifactUri(remarksUri)?.artifactKind, 'optimization-remarks');
	const pythonUri = getArtifactUri(
		vscode.Uri.file('/project/main.py'),
		{ id: 'default:python' },
		'assembly',
		'default',
	);
	assert.match(pythonUri.path, /main\.asm$/);
	assert.equal(parseArtifactUri(pythonUri)?.artifactKind, 'assembly');
	const stackUri = getArtifactUri(
		source,
		{
			id: 'cmake:app:Debug/x64',
		},
		'stack-analysis',
		'default',
	);
	assert.match(stackUri.path, /main\.stack\.cpp$/);
	assert.equal(parseArtifactUri(stackUri)?.artifactKind, 'stack-analysis');
	assert.equal(parseArtifactUri(vscode.Uri.file('/project/main.cpp')), undefined);
	assert.equal(parseArtifactUri(uri.with({ query: '' })), undefined);
}

function verifyArtifactNavigationProviders(): void {
	const documentUri = vscode.Uri.parse(
		'coglens-artifact:/project/main.disasm?source=file%3A%2Fproject%2Fmain.cpp&variant=test&artifact=binary-disassembly&preset=default',
	);
	const sourcePath = path.join('/project', 'main.cpp');
	const artifact: RenderedTextArtifact = {
		kind: 'binary-disassembly',
		listingSyntax: 'native-assembly',
		presentation: 'text',
		diagnostics: [],
		durationMs: 1,
		generatedAt: 0,
		command: {
			executable: process.execPath,
			args: [],
			cwd: '/project',
			environmentVariableNames: [],
		},
		text: '',
		lines: [
			{ text: 'entry:', source: { file: sourcePath, line: 4, column: 2 } },
			{ text: '  call helper', address: 16, opcodes: ['e8', '00', '00', '00', '00'], disassembly: 'call helper' },
			{ text: 'helper:' },
			{ text: '  ret' },
		],
		sourceLocations: [{ line: 0, uri: sourcePath, sourceLine: 4 }],
		links: [{ line: 1, startCharacter: 7, endCharacter: 13, targetLine: 2 }],
		folds: [
			{ startLine: 0, endLine: 1 },
			{ startLine: 2, endLine: 3 },
		],
		symbols: [
			{ name: 'entry', line: 0 },
			{ name: 'helper', line: 2 },
		],
		metrics: {},
		raw: '',
		truncated: false,
		toolOutputTruncated: false,
	};
	const provider = new ArtifactNavigationProvider((uri) =>
		uri.toString() === documentUri.toString() ? artifact : undefined,
	);
	const document = { uri: documentUri } as vscode.TextDocument;
	const cancellation = new vscode.CancellationTokenSource();
	try {
		const definition = provider.provideDefinition(document, new vscode.Position(0, 0), cancellation.token);
		assert.ok(definition instanceof vscode.Location);
		assert.equal(definition.range.start.line, 3);

		const links = provider.provideDocumentLinks(document, cancellation.token);
		assert.ok(Array.isArray(links));
		assert.equal(links[0].target?.fragment, 'L3');
		assert.equal(links[0].range.start.character, 7);

		const folds = provider.provideFoldingRanges(document, {} as vscode.FoldingContext, cancellation.token);
		assert.ok(Array.isArray(folds));
		assert.deepEqual(
			folds.map((fold) => [fold.start, fold.end]),
			[
				[0, 1],
				[2, 3],
			],
		);

		const hover = provider.provideHover(document, new vscode.Position(0, 0), cancellation.token);
		assert.ok(hover instanceof vscode.Hover);
		const hoverContent = hover.contents[0];
		assert.ok(hoverContent instanceof vscode.MarkdownString);
		assert.match(hoverContent.value, /main\.cpp:4:3/);

		const instructionHover = provider.provideHover(document, new vscode.Position(1, 8), cancellation.token);
		assert.ok(instructionHover instanceof vscode.Hover);
		const instructionContent = instructionHover.contents[0];
		assert.ok(instructionContent instanceof vscode.MarkdownString);
		assert.match(instructionContent.value, /\*\*call\*\*/i);
		assert.match(instructionContent.value, /procedure.*linking.*information/i);
		assert.match(instructionContent.value, /Instruction reference/);
		assert.match(instructionContent.value, /Address:.*0x10/);
		assert.match(instructionContent.value, /Branch.*target:.*helper:/);

		const dotnetArtifact: RenderedTextArtifact = {
			...artifact,
			kind: 'assembly',
			listingSyntax: 'dotnet-il',
			lines: [{ text: 'IL_0000: callvirt instance string [System.Runtime]System.Object::ToString()' }],
			links: [],
		};
		const dotnetProvider = new ArtifactNavigationProvider((uri) =>
			uri.toString() === documentUri.toString() ? dotnetArtifact : undefined,
		);
		const dotnetHover = dotnetProvider.provideHover(document, new vscode.Position(0, 10), cancellation.token);
		assert.ok(dotnetHover instanceof vscode.Hover);
		const dotnetContent = dotnetHover.contents[0];
		assert.ok(dotnetContent instanceof vscode.MarkdownString);
		assert.match(dotnetContent.value, /\*\*callvirt\*\*.*\.NET IL/i);
		assert.match(dotnetContent.value, /method.*associated.*object/i);
		assert.match(dotnetContent.value, /Instruction reference/);

		const symbols = provider.provideDocumentSymbols(document, cancellation.token);
		assert.ok(Array.isArray(symbols));
		assert.deepEqual(
			symbols.map((symbol) => symbol.name),
			['entry', 'helper'],
		);
	} finally {
		cancellation.dispose();
	}
}

async function verifyDisplayFilterCaching(workspaceFolder: vscode.WorkspaceFolder): Promise<void> {
	const configurationChange = new vscode.EventEmitter<void>();
	const configuration = testConfiguration(configurationChange);
	const service = new CompilationService(configuration);
	const profile = toolchainProfile('cache', '-O2');
	service.toolchainRegistry.reconcile('user', [profile]);
	const registered = { id: ToolchainRegistry.profileId('user', profile.id) };
	const backend = service.toolchainRegistry.getToolchainById(registered.id);
	assert.ok(backend);
	const dependency = vscode.Uri.joinPath(workspaceFolder.uri, 'coglens-cache-dependency.h');
	fs.writeFileSync(dependency.fsPath, 'one\n');
	let toolchainRuns = 0;
	backend.produceAssembly = async (source) => {
		toolchainRuns++;
		const input = fs.statSync(source.fsPath);
		const dependencyInput = fs.statSync(dependency.fsPath);
		return {
			kind: 'assembly',
			text: '.text\nmain:\n  ret',
			diagnostics: [],
			stdout: '',
			stderr: '',
			durationMs: 1,
			generatedAt: 0,
			truncated: toolchainRuns === 2,
			inputs: [
				{
					uri: pathToFileURL(source.fsPath).href,
					size: input.size,
					mtimeMs: input.mtimeMs,
				},
				{
					uri: pathToFileURL(dependency.fsPath).href,
					size: dependencyInput.size,
					mtimeMs: dependencyInput.mtimeMs,
				},
			],
			dependencyCoverage: 'complete',
			command: {
				executable: profile.executable,
				arguments: [],
				environmentVariableNames: [],
				workingDirectory: workspaceFolder.uri.fsPath,
			},
		};
	};
	const variant = compilationVariant(
		'test:cache-variant',
		vscode.Uri.joinPath(workspaceFolder.uri, 'package.json'),
		'Cache test',
	);
	variant.toolchainProfileId = registered.id;
	variant.workingDirectory = workspaceFolder.uri.fsPath;
	const cancellation = new vscode.CancellationTokenSource();

	await service.compile({
		variant,
		artifactKind: 'assembly',
		presetId: 'default',
		extraArguments: [],
		options: defaultArtifactOptions,
		cancellationToken: cancellation.token,
	});
	await service.compile({
		variant,
		artifactKind: 'assembly',
		presetId: 'default',
		extraArguments: [],
		options: {
			...defaultArtifactOptions,
			display: { ...defaultArtifactOptions.display, directives: false },
		},
		cancellationToken: cancellation.token,
	});
	assert.equal(toolchainRuns, 1, 'Display-only option changes should reuse raw toolchain output');
	const truncatedArtifact = await service.compile({
		variant,
		artifactKind: 'assembly',
		presetId: 'default',
		extraArguments: [],
		options: {
			production: { ...defaultArtifactOptions.production, intel: true },
			display: { ...defaultArtifactOptions.display, directives: false },
		},
		cancellationToken: cancellation.token,
	});
	assert.equal(toolchainRuns, 2, 'Production option changes should invoke the toolchain');
	assert.equal(
		truncatedArtifact.status === 'available' && truncatedArtifact.artifact.truncated,
		true,
		'Toolchain truncation should propagate to the artifact',
	);
	fs.writeFileSync(dependency.fsPath, 'dependency changed\n');
	await service.compile({
		variant,
		artifactKind: 'assembly',
		presetId: 'default',
		extraArguments: [],
		options: defaultArtifactOptions,
		cancellationToken: cancellation.token,
	});
	assert.equal(toolchainRuns, 3, 'A changed compiler-reported dependency should invalidate raw output');

	cancellation.dispose();
	service.dispose();
	configurationChange.dispose();
	fs.rmSync(dependency.fsPath, { force: true });
}

async function verifyMissingSourceIsUnavailable(workspaceFolder: vscode.WorkspaceFolder): Promise<void> {
	const configurationChange = new vscode.EventEmitter<void>();
	const configuration = testConfiguration(configurationChange);
	const service = new CompilationService(configuration);
	service.toolchainRegistry.reconcile('user', [toolchainProfile('missing-source', '-O2')]);
	const registered = { id: ToolchainRegistry.profileId('user', 'missing-source') };
	const backend = service.toolchainRegistry.getToolchainById(registered.id);
	assert.ok(backend);
	let runs = 0;
	backend.produceAssembly = async () => {
		runs++;
		throw new Error('Producer must not run for a missing source');
	};
	const source = vscode.Uri.joinPath(workspaceFolder.uri, 'definitely-missing-source.cpp');
	const variant = compilationVariant('test:missing-source', source, 'Missing source');
	variant.toolchainProfileId = registered.id;
	const cancellation = new vscode.CancellationTokenSource();
	try {
		const result = await service.compile({
			variant,
			artifactKind: 'assembly',
			presetId: 'default',
			extraArguments: [],
			options: defaultArtifactOptions,
			cancellationToken: cancellation.token,
		});
		assert.equal(result.status, 'unavailable');
		assert.equal(runs, 0);
	} finally {
		cancellation.dispose();
		service.dispose();
		configurationChange.dispose();
	}
}

function verifyRegistryReconciliation(): void {
	const registry = new ToolchainRegistry();
	let changeCount = 0;
	const subscription = registry.onDidChange(() => changeCount++);
	const profile = toolchainProfile('test', '-O1');
	assert.equal(registry.reconcile('user', [profile]), true);
	const registered = registry.getToolchainById('user:test');
	assert.ok(registered);
	assert.equal(registered.profile.id, 'user:test');
	assert.equal(registry.reconcile('cmake', [profile]), true);
	const otherOrigin = registry.getToolchainById('cmake:test');
	assert.ok(otherOrigin);
	assert.equal(otherOrigin.profile.id, 'cmake:test');
	assert.notEqual(registered.profile.id, otherOrigin.profile.id);
	assert.equal(registry.reconcile('user', [{ ...profile, defaultArguments: ['-O2'] }]), true);
	assert.equal(registry.reconcile('user', []), true);
	assert.equal(changeCount, 4);
	subscription.dispose();
	registry.dispose();
}

function verifyVariantSnapshots(): void {
	const database = new CompilationConfigDatabase();
	const source = vscode.Uri.file('/project/main.cpp');
	const first = compilationVariant('cmake:first', source, 'Debug');
	const second = compilationVariant('cmake:second', source, 'Release');
	database.reconcile('cmake', [first, second]);
	assert.equal(database.getVariants(source).length, 2);
	database.reconcile('cmake', [second, first]);
	assert.deepEqual(
		database.getVariants(source).map((item) => item.id),
		[second.id, first.id],
	);
	assert.equal(database.selectVariant(source, second.id), true);
	assert.equal(database.getSelectedVariant(source)?.id, second.id);
	database.reconcile('cmake', [first]);
	assert.deepEqual(
		database.getVariants(source).map((item) => item.id),
		[first.id],
	);
	assert.equal(database.getSelectedVariant(source)?.id, first.id);
	database.dispose();
}

function verifyUriMapping(): void {
	const map = sourceUriMap<number>();
	map.set(vscode.Uri.file('/Project/Source.cpp'), 1);
	const lookup = map.get(vscode.Uri.file('/project/source.cpp').with({ fragment: 'ignored' }));
	assert.equal(lookup, process.platform === 'win32' ? 1 : undefined);
}

function verifyDiagnostics(workspaceFolder: vscode.WorkspaceFolder): void {
	const workingDirectory = vscode.Uri.joinPath(workspaceFolder.uri, 'build').fsPath;
	const fallback = vscode.Uri.joinPath(workspaceFolder.uri, 'src', 'main.cpp');
	const diagnostics = parseToolDiagnostics(
		[
			'../src/main.cpp:4:7: error: expected expression',
			'../src/main.cpp(8,3): warning C4100: unreferenced parameter',
			'template(12): required from here while evaluating error traits',
		].join('\n'),
		fallback,
		workingDirectory,
	);
	assert.equal(diagnostics.length, 2);
	assert.equal(diagnostics[0].uri.fsPath, path.resolve(workingDirectory, '..', 'src', 'main.cpp'));
	assert.equal(diagnostics[0].line, 3);
	assert.equal(diagnostics[0].column, 6);
	assert.equal(diagnostics[0].severity, 'error');
	assert.equal(diagnostics[1].line, 7);
	assert.equal(diagnostics[1].severity, 'warning');

	const rustDiagnostics = parseToolDiagnostics(
		[
			'error[E0308]: mismatched types',
			`  --> ${path.join(workingDirectory, 'source.rs')}:5:9`,
			'warning: unused variable: `value`',
			`  --> ${path.join(workingDirectory, 'source.rs')}:8:13`,
		].join('\n'),
		fallback,
		workingDirectory,
	);
	assert.equal(rustDiagnostics.length, 2);
	assert.equal(rustDiagnostics[0].line, 4);
	assert.equal(rustDiagnostics[0].column, 8);
	assert.equal(rustDiagnostics[0].severity, 'error');
	assert.equal(rustDiagnostics[0].message, '[E0308] mismatched types');
	assert.equal(rustDiagnostics[1].severity, 'warning');

	const pythonDiagnostics = parseToolDiagnostics(
		[
			`  File "${path.join(workingDirectory, 'source.py')}", line 3`,
			'    value =',
			'           ^',
			'SyntaxError: invalid syntax',
		].join('\n'),
		fallback,
		workingDirectory,
	);
	assert.equal(pythonDiagnostics.length, 1);
	assert.equal(pythonDiagnostics[0].line, 2);
	assert.equal(pythonDiagnostics[0].column, 7);
	assert.equal(pythonDiagnostics[0].message, 'SyntaxError: invalid syntax');
}

async function verifyArtifactDetailsTree(workspaceFolder: vscode.WorkspaceFolder): Promise<void> {
	const source = vscode.Uri.joinPath(workspaceFolder.uri, 'details.cpp');
	const variant = compilationVariant('details:debug', source, 'Details Debug');
	const artifactUri = getArtifactUri(source, variant, 'stack-analysis', 'default');
	const snapshot: ArtifactDocumentSnapshot = {
		identity: {
			documentUri: artifactUri.toString(),
			sourceUri: source.toString(),
			sourceLabel: source.fsPath,
			artifactKind: 'stack-analysis',
			artifactLabel: 'Stack analysis',
			presetId: 'default',
			variantId: variant.id,
			variantLabel: variant.displayLabel,
			toolchainId: 'details:clang',
			toolchainLabel: 'Details Clang',
			toolchainKind: 'clang',
			renderedIdentity: artifactUri.toString(),
		},
		status: {
			state: 'successful',
			assembly: {} as never,
			artifact: {
				kind: 'stack-analysis',
				presentation: 'text',
				diagnostics: [],
				durationMs: 2,
				generatedAt: 1_700_000_000_000,
				command: {
					executable: 'clang++',
					args: ['-O2'],
					cwd: workspaceFolder.uri.fsPath,
					environmentVariableNames: ['API_KEY', 'TOKEN'],
				},
				text: '',
				lines: [],
				sourceLocations: [],
				links: [],
				folds: [],
				symbols: [],
				metrics: { largestFrame: 64 },
				raw: '',
				truncated: false,
				toolOutputTruncated: false,
			},
			truncated: false,
		},
	};
	const artifacts = {
		getArtifactDocumentState: (uri: vscode.Uri) =>
			uri.toString() === artifactUri.toString() ? snapshot : undefined,
	} as unknown as ArtifactDocumentProvider;
	const provider = new ArtifactDetailsTreeProvider(artifacts);
	provider.setActiveDocument(vscode.Uri.file(source.fsPath));
	assert.match(provider.getChildren()[0].label ?? '', /Open a Cogitator Lens artifact/);
	provider.setActiveDocument(artifactUri);
	const roots = provider.getChildren();
	assert.deepEqual(
		roots.map((node) => node.label),
		['Artifact', 'Status', 'Invocation', 'Environment', 'Metrics'],
	);
	const environment = roots.find((node) => node.label === 'Environment');
	assert.deepEqual(
		environment?.children?.map((node) => node.label),
		['API_KEY', 'TOKEN'],
	);
	assert.doesNotMatch(JSON.stringify(roots), /secret-value/);
	const metric = roots.find((node) => node.label === 'Metrics')?.children?.[0];
	assert.ok(metric);
	const previousClipboard = await vscode.env.clipboard.readText();
	try {
		await vscode.commands.executeCommand('coglens.CopyText', metric);
		assert.equal(await vscode.env.clipboard.readText(), '64');
	} finally {
		await vscode.env.clipboard.writeText(previousClipboard);
	}
}

async function verifyNativeStackProduction(workspaceFolder: vscode.WorkspaceFolder): Promise<void> {
	const root = workspaceFolder.uri.fsPath;
	const raw = await runFakeNativeStackProducer(root, []);
	assert.match(raw.text, /fake_function\(\)\s+16\s+static/);
	assert.equal(raw.dependencyCoverage, 'complete');
	assert.equal(raw.inputs.length, 1);
	assert.ok(raw.command.environmentVariableNames.includes('COGLENS_FAKE_TRACE'));
	assert.deepEqual(raw.command.environmentVariableNames, [...raw.command.environmentVariableNames].sort());
	const output = raw.command.arguments[raw.command.arguments.indexOf('-o') + 1];
	assert.equal(fs.existsSync(path.dirname(output)), false);

	const lto = await runFakeNativeStackProducer(root, ['-flto=auto']);
	assert.ok(lto.command.arguments.includes('-flto=auto'));
	assert.ok(
		lto.command.arguments.indexOf('-fno-lto') > lto.command.arguments.indexOf('-flto=auto'),
		'stack analysis must disable CMake-provided LTO after provider arguments',
	);
	assert.match(lto.text, /fake_function\(\)\s+16\s+static/);

	await assertFakeNativeStackFailure(
		root,
		['--missing-stack'],
		(error: unknown) => error instanceof MissingToolOutputError,
	);
	await assertFakeNativeStackFailure(
		root,
		['--large-stack'],
		(error: unknown) => error instanceof ExecError && error.kind === 'output-limit',
	);
	await assertFakeNativeStackFailure(
		root,
		['--fail'],
		(error: unknown) => error instanceof Error && /exited with code 2/.test(error.message),
	);

	const dependencyFallback = await runFakeNativeStackProducer(root, ['--dependency-fail']);
	assert.equal(dependencyFallback.dependencyCoverage, 'source-only');
	assert.equal(dependencyFallback.inputs.length, 1);

	const clangCl = await runFakeClangClStackProducer(root);
	assert.ok(clangCl.command.arguments.includes('/c'));
	assert.ok(clangCl.command.arguments.includes('/clang:-fstack-usage'));
	assert.ok(clangCl.command.arguments.includes('/clang:-gline-tables-only'));
	assert.ok(clangCl.command.arguments.includes('/DPROJECT_BUILD'));
	assert.ok(!clangCl.command.arguments.includes('/Foignored.obj'));
	assert.match(clangCl.text, /source\.cpp:1:fake_function\(\)\s+16\s+static/);
	const clangClOutputIndex = clangCl.command.arguments.indexOf('/clang:-o');
	assert.notEqual(clangClOutputIndex, -1);
	const clangClOutput = clangCl.command.arguments[clangClOutputIndex + 1];
	assert.match(clangClOutput, /^\/clang:/);
	assert.equal(fs.existsSync(path.dirname(clangClOutput.replace(/^\/clang:/, ''))), false);

	await verifyFakeNativeStackCancellation(root);
}

async function runFakeClangClStackProducer(
	repositoryRoot: string,
): Promise<import('../../src/types/index.js').RawArtifact> {
	const cancellation = new vscode.CancellationTokenSource();
	const profile: ToolchainProfile = {
		id: 'fake-stack-clang-cl',
		displayName: 'Fake stack clang-cl',
		kind: 'clang-cl',
		executable: 'node',
		defaultArguments: [path.join(repositoryRoot, 'test/fixtures/stack-analysis/fake-compiler.cjs')],
		environment: {},
		tools: {},
	};
	const {
		prepareEnvironment: _prepareEnvironment,
		dependencyCollection: _dependencyCollection,
		...definition
	} = toolchainDefinitions['clang-cl'];
	const backend = new ToolchainBackend(profile, definition, extensionToolchainHost);
	try {
		return await backend.produceArtifact(
			'stack-analysis',
			vscode.Uri.file(path.join(repositoryRoot, 'test/fixtures/binary/source.cpp')),
			{
				args: ['/DPROJECT_BUILD', '/Foignored.obj', '/clang:-fno-stack-usage'],
				env: {},
				workingDirectory: repositoryRoot,
				productionOptions: defaultArtifactOptions.production,
			},
			clangClStackUsageOutput,
			cancellation.token,
		);
	} finally {
		cancellation.dispose();
	}
}

async function verifyFakeNativeStackCancellation(repositoryRoot: string): Promise<void> {
	const traceDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'coglens-stack-cancel-'));
	const trace = path.join(traceDirectory, 'temporary-directory.txt');
	const cancellation = new vscode.CancellationTokenSource();
	const profile: ToolchainProfile = {
		id: 'fake-stack-cancel',
		displayName: 'Fake stack cancellation',
		kind: 'gcc',
		executable: 'node',
		defaultArguments: [
			path.join(repositoryRoot, 'test/fixtures/stack-analysis/fake-compiler.cjs'),
			'--wait-for-cancellation',
		],
		environment: {},
		tools: {},
	};
	const backend = new ToolchainBackend(profile, toolchainDefinitions.gcc, extensionToolchainHost);
	try {
		const pending = backend.produceArtifact(
			'stack-analysis',
			vscode.Uri.file(path.join(repositoryRoot, 'test/fixtures/binary/source.cpp')),
			{
				args: [],
				env: { COGLENS_FAKE_TRACE: trace },
				workingDirectory: repositoryRoot,
				productionOptions: defaultArtifactOptions.production,
			},
			nativeStackUsageOutput,
			cancellation.token,
		);
		await waitForFile(trace);
		const temporaryDirectory = await fs.promises.readFile(trace, 'utf8');
		cancellation.cancel();
		await assert.rejects(pending, (error: unknown) => error instanceof ExecError && error.kind === 'cancelled');
		assert.equal(fs.existsSync(temporaryDirectory), false);
	} finally {
		cancellation.cancel();
		cancellation.dispose();
		await fs.promises.rm(traceDirectory, { recursive: true, force: true });
	}
}

async function waitForFile(filename: string): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!fs.existsSync(filename)) {
		if (Date.now() >= deadline) {
			throw new Error(`Timed out waiting for fixture trace: ${filename}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

async function runFakeNativeStackProducer(
	repositoryRoot: string,
	additionalArguments: readonly string[],
): Promise<import('../../src/types/index.js').RawArtifact> {
	const traceDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'coglens-stack-test-'));
	const trace = path.join(traceDirectory, 'temporary-directory.txt');
	const cancellation = new vscode.CancellationTokenSource();
	try {
		const profile: ToolchainProfile = {
			id: 'fake-stack-gcc',
			displayName: 'Fake stack GCC',
			kind: 'gcc',
			executable: 'node',
			defaultArguments: [
				path.join(repositoryRoot, 'test/fixtures/stack-analysis/fake-compiler.cjs'),
				...additionalArguments,
			],
			environment: {},
			tools: {},
		};
		const backend = new ToolchainBackend(profile, toolchainDefinitions.gcc, extensionToolchainHost);
		try {
			let observedInvocation: import('../../src/types/index.js').InvocationDetails | undefined;
			const raw = await backend.produceArtifact(
				'stack-analysis',
				vscode.Uri.file(path.join(repositoryRoot, 'test/fixtures/binary/source.cpp')),
				{
					args: [],
					env: { COGLENS_FAKE_TRACE: trace },
					workingDirectory: repositoryRoot,
					productionOptions: defaultArtifactOptions.production,
					onInvocation: (details) => {
						observedInvocation = details;
					},
				},
				nativeStackUsageOutput,
				cancellation.token,
			);
			assert.deepEqual(observedInvocation, {
				executable: raw.command.executable,
				args: raw.command.arguments,
				cwd: raw.command.workingDirectory,
				environmentVariableNames: raw.command.environmentVariableNames,
			});
			return raw;
		} catch (error) {
			if (error instanceof ToolExitError) {
				throw new Error(`${error.message}\nstdout: ${error.stdout}\nstderr: ${error.stderr}`, { cause: error });
			}
			throw error;
		}
	} finally {
		cancellation.dispose();
		await fs.promises.rm(traceDirectory, { recursive: true, force: true });
	}
}

async function assertFakeNativeStackFailure(
	repositoryRoot: string,
	additionalArguments: readonly string[],
	predicate: (error: unknown) => boolean,
): Promise<void> {
	const traceDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'coglens-stack-test-'));
	const trace = path.join(traceDirectory, 'temporary-directory.txt');
	const cancellation = new vscode.CancellationTokenSource();
	try {
		const profile: ToolchainProfile = {
			id: 'fake-stack-gcc',
			displayName: 'Fake stack GCC',
			kind: 'gcc',
			executable: 'node',
			defaultArguments: [
				path.join(repositoryRoot, 'test/fixtures/stack-analysis/fake-compiler.cjs'),
				...additionalArguments,
			],
			environment: {},
			tools: {},
		};
		const backend = new ToolchainBackend(profile, toolchainDefinitions.gcc, extensionToolchainHost);
		await assert.rejects(
			backend.produceArtifact(
				'stack-analysis',
				vscode.Uri.file(path.join(repositoryRoot, 'test/fixtures/binary/source.cpp')),
				{
					args: [],
					env: { COGLENS_FAKE_TRACE: trace },
					workingDirectory: repositoryRoot,
					productionOptions: defaultArtifactOptions.production,
				},
				nativeStackUsageOutput,
				cancellation.token,
			),
			predicate,
		);
		if (fs.existsSync(trace)) {
			const temporaryDirectory = fs.readFileSync(trace, 'utf8');
			assert.equal(fs.existsSync(temporaryDirectory), false);
		}
	} finally {
		cancellation.dispose();
		await fs.promises.rm(traceDirectory, { recursive: true, force: true });
	}
}

async function verifyFilterChangeSignal(): Promise<void> {
	const configurationChange = new vscode.EventEmitter<void>();
	let persistedOptions = defaultArtifactOptions;
	let updateFolder: vscode.WorkspaceFolder | undefined;
	const configuration = testConfiguration(configurationChange, {
		getArtifactOptions: (kind) => (kind === 'assembly' ? persistedOptions : defaultArtifactOptions),
		updateArtifactOptions: async (kind, options, folder) => {
			updateFolder = folder;
			if (kind === 'assembly') {
				persistedOptions = options;
			}
			configurationChange.fire();
		},
	});
	const service = new CompilationService(configuration);
	let changes = 0;
	const subscription = service.onArtifactOptionsChanged(() => changes++);

	service.setArtifactOption('assembly', 'labels', false);
	assert.equal(changes, 1);
	assert.equal(service.getArtifactOptions('assembly').display.labels, false);
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(updateFolder, undefined, 'Global artifact options must use workspace scope');
	assert.equal(
		service.getArtifactOptions('assembly').display.labels,
		false,
		'The persisted configuration event must not revert the first toggle',
	);
	service.setArtifactOption('assembly', 'labels', false);
	assert.equal(changes, 1, 'An unchanged option should not trigger another refresh');

	subscription.dispose();
	service.dispose();
	configurationChange.dispose();
}

function verifyManualVariantConfiguration(workspaceFolder: vscode.WorkspaceFolder): void {
	const configurationChange = new vscode.EventEmitter<void>();
	const profile = toolchainProfile('manual-tool', '-Wall');
	const source = vscode.Uri.joinPath(workspaceFolder.uri, 'src', 'manual.cpp');
	let label = 'Workspace Debug';
	const configuration = testConfiguration(configurationChange, {
		getToolchains: () => [profile],
		getManualCompilationVariants: () => [
			{
				id: 'manual:test',
				source: source.fsPath,
				displayLabel: label,
				toolchainProfileId: 'user:manual-tool',
				workingDirectory: workspaceFolder.uri.fsPath,
				arguments: ['-O0'],
				environment: {},
			},
		],
	});
	const service = new CompilationService(configuration);
	try {
		const initial = service.getVariants(source);
		assert.equal(initial.length, 1);
		assert.equal(initial[0].provider, 'manual');
		assert.equal(initial[0].toolchainProfileId, 'user:manual-tool');
		assert.ok(service.toolchainRegistry.getToolchainById(initial[0].toolchainProfileId));

		label = 'Workspace Release';
		configurationChange.fire();
		assert.equal(service.getVariants(source)[0].displayLabel, label);
	} finally {
		service.dispose();
		configurationChange.dispose();
	}
}

function verifyTreeModels(workspaceFolder: vscode.WorkspaceFolder): void {
	const profile: ToolchainProfile = {
		...toolchainProfile('cmake:gcc', '-O2'),
		tools: { demangler: process.execPath },
	};
	const compilerNode = buildToolchainTreeNode(profile, 'cmake');
	assert.equal(compilerNode.description, 'CMake');
	for (const expectedGroup of ['Toolchain information', 'Arguments', 'Environment overrides', 'Capabilities']) {
		assert.ok(findTreeNode(compilerNode, expectedGroup), `Missing toolchain tree group: ${expectedGroup}`);
	}

	const optionRoots = buildArtifactOptionsTree(defaultArtifactOptions, profile);
	const outputOptions = optionRoots.find((node) => node.label === 'Production Options');
	assert.equal(outputOptions?.children?.find((node) => node.label === 'Intel syntax')?.disabled, false);
	assert.equal(outputOptions?.children?.find((node) => node.label === 'Demangle symbols')?.disabled, false);
	const msvcOptions = buildArtifactOptionsTree(defaultArtifactOptions, {
		...profile,
		kind: 'msvc',
		tools: {},
	});
	const msvcOutput = msvcOptions.find((node) => node.label === 'Production Options');
	const intel = msvcOutput?.children?.find((node) => node.label === 'Intel syntax');
	const demangle = msvcOutput?.children?.find((node) => node.label === 'Demangle symbols');
	assert.equal(intel?.disabled, true);
	assert.equal(intel?.description, 'Inherent');
	assert.equal(demangle?.disabled, true);
	assert.equal(demangle?.description, 'Unavailable');
	const presetNode = buildArtifactPresetTreeNode(
		{
			id: 'optimized',
			artifactKind: 'assembly',
			extraArguments: ['-O3'],
			productionOptions: { intel: true },
		},
		workspaceFolder.uri,
	);
	assert.equal(presetNode.treeContext, 'artifactPreset');
	assert.equal(presetNode.description, 'Assembly');
	assert.equal(findTreeNode(presetNode, 'Extra arguments')?.children?.[0]?.label, '-O3');
	assert.equal(findTreeNode(presetNode, 'Production options')?.children?.[0]?.description, 'Enabled');

	const coreSource = vscode.Uri.joinPath(workspaceFolder.uri, 'src', 'core', 'main.cpp');
	const uiSource = vscode.Uri.joinPath(workspaceFolder.uri, 'src', 'ui', 'window.cpp');
	const debug = {
		...compilationVariant('cmake:debug', coreSource, 'app · Debug'),
		project: 'DemoProject',
		target: 'app',
		configuration: 'Debug',
		toolchainProfileId: profile.id,
	};
	const release = {
		...compilationVariant('cmake:release', uiSource, 'app · Release'),
		project: 'DemoProject',
		target: 'app',
		configuration: 'Release',
		toolchainProfileId: profile.id,
	};
	const variantsBySource = new Map([
		[coreSource.toString(), [debug]],
		[uiSource.toString(), [release]],
	]);
	const compilationService = {
		getAllSources: () => [coreSource, uiSource],
		getVariants: (source: vscode.Uri) => variantsBySource.get(source.toString()) ?? [],
		toolchainRegistry: {
			getToolchainById: () => ({ profile }),
		},
	} as unknown as CompilationService;

	const roots = buildCompilationInfoTree(compilationService);
	assert.equal(roots.length, 1);
	assert.equal(roots[0].label, workspaceFolder.name);
	const project = directChild(roots[0], 'DemoProject');
	const target = directChild(project, 'app');
	const debugConfiguration = directChild(target, 'Debug');
	const releaseConfiguration = directChild(target, 'Release');
	assert.ok(findTreeNode(debugConfiguration, 'src'));
	assert.ok(findTreeNode(debugConfiguration, 'core'));
	assert.ok(findTreeNode(debugConfiguration, 'main.cpp'));
	assert.ok(findTreeNode(releaseConfiguration, 'ui'));
	assert.ok(findTreeNode(releaseConfiguration, 'window.cpp'));
	assert.ok(findTreeNode(debugConfiguration, 'Working directory'));
	assert.ok(findTreeNode(debugConfiguration, 'Environment overrides'));
	const sourceNode = findTreeNode(debugConfiguration, 'main.cpp');
	assert.equal(sourceNode?.command?.command, 'vscode.open');
	const variantNode = findTreeNode(debugConfiguration, 'app · Debug');
	assert.equal(variantNode?.treeContext, 'compilationVariant');

	const provider = new CompilationInfoTreeProvider(compilationService);
	provider.getChildren();
	const revealed = provider.findSource(coreSource);
	assert.equal(revealed?.label, 'main.cpp');
	assert.ok(revealed && provider.getParent(revealed));
}

function directChild(node: { children?: unknown[] }, label: string): ToolchainTreeNode {
	const child = (node.children as ToolchainTreeNode[] | undefined)?.find((item) => item.label === label);
	assert.ok(child, `Missing direct tree child: ${label}`);
	return child;
}

function findTreeNode(node: { label?: string; children?: unknown[] }, label: string): ToolchainTreeNode | undefined {
	if (node.label === label) {
		return node as ToolchainTreeNode;
	}
	for (const child of (node.children as ToolchainTreeNode[] | undefined) ?? []) {
		const found = findTreeNode(child, label);
		if (found) {
			return found;
		}
	}
	return undefined;
}

function toolchainProfile(id: string, argument: string): ToolchainProfile {
	return {
		id,
		displayName: 'Test GCC',
		kind: 'gcc',
		executable: process.execPath,
		defaultArguments: [argument],
		environment: {},
		tools: {},
	};
}

function compilationVariant(id: string, source: vscode.Uri, label: string): CompilationVariant {
	return {
		id,
		provider: 'cmake',
		source,
		toolchainProfileId: 'cmake:gcc',
		workingDirectory: '/project',
		arguments: [],
		environment: {},
		displayLabel: label,
	};
}

function testConfiguration(
	changes: vscode.EventEmitter<void>,
	overrides: Partial<ConfigurationService> = {},
): ConfigurationService {
	return {
		onDidChange: changes.event,
		getToolchains: () => [],
		getArtifactOptions: () => defaultArtifactOptions,
		getDefaultCompilationSettings: () => undefined,
		getManualCompilationVariants: () => [],
		getDimUnusedSourceLines: () => true,
		updateToolchains: async () => undefined,
		updateArtifactOptions: async () => undefined,
		...overrides,
	} as unknown as ConfigurationService;
}
