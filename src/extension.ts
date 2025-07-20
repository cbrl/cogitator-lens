import vscode from 'vscode';
import { workspace, window, commands, ExtensionContext, TextDocumentShowOptions, ViewColumn, TreeView } from 'vscode';
import { AsmProvider, getAsmUri } from './asm-document/asm-provider';
import { AsmDecorator } from './asm-document/asm-decorator';
import { AsmDefinitionProvider } from './asm-document/asm-definition-provider';
import { CompilerInfo } from './compiler';
import { CompileInfoDatabase, CompileManager, CompilerCache, CompilationInfo } from './compile-database';
import { CmakeMonitor } from './buildsystems/cmake';
import { CompilerTreeProvider, CompilerTreeNode } from './tree/compiler-tree';
import { CompilationInfoTreeProvider } from './tree/compilation-info-tree';
import { TreeNode, TreeProvider } from './tree/treedata';
import assert from 'assert';
import path from 'path';
import { getCompilerByExe } from './compilers/compiler-map';

/*
TODO:
  - objdump support (is this needed?)
  - Settings for binary ASM parsing
*/

function setupCommands(
	context: ExtensionContext,
	compileManager: CompileManager,
	compilerTreeProvider: CompilerTreeProvider,
	infoTreeProvider: CompilationInfoTreeProvider
) {
	const GetInput = vscode.commands.registerCommand('coglens.GetInput', async (node: TreeNode | undefined) => {
		if (node === undefined) {
			vscode.window.showErrorMessage("No node selected.");
			return;
		}

		const { objectRef, attr } = node;

		assert(objectRef !== undefined && attr !== undefined && typeof(objectRef[attr]) === 'string');

		const last = objectRef[attr] as string ?? '';
		const userInput = await vscode.window.showInputBox({
			placeHolder: 'Enter text',
			value: last,
		});

		if (userInput) {
			objectRef[attr] = userInput;
			node.tree!.refresh();
		}
	});

	const GetFile = vscode.commands.registerCommand('coglens.GetFile', async (node: TreeNode | undefined) => {
		if (node === undefined) {
			vscode.window.showErrorMessage("No node selected.");
			return;
		}

		const { objectRef, attr } = node;

		assert(objectRef !== undefined && attr !== undefined && typeof(objectRef[attr]) === 'string');

		const last = objectRef[attr] as string ?? '';
		const userInput = await vscode.window.showOpenDialog({ defaultUri: vscode.Uri.file(last), canSelectMany: false });

		if (userInput) {
			objectRef[attr] = userInput?.at(0)?.fsPath;
			node.tree!.refresh();
		}
	});

	const ClearInput = vscode.commands.registerCommand('coglens.ClearInput', async (node: TreeNode | undefined) => {
		if (node === undefined) {
			vscode.window.showErrorMessage("No node selected.");
			return;
		}

		const { objectRef, attr } = node;

		assert(objectRef !== undefined && attr !== undefined && typeof(objectRef[attr]) === 'string');

		objectRef[attr] = '';
		node.tree!.refresh();
	});

	const CopyText = vscode.commands.registerCommand('coglens.CopyText', async (node: TreeNode | undefined) => {
		if (node === undefined) {
			vscode.window.showErrorMessage("No node selected.");
			return;
		}

		vscode.env.clipboard.writeText(node.label!);
	});

	const AddElement = vscode.commands.registerCommand("coglens.AddElement", async (node: TreeNode | undefined) => {
		if (node === undefined) {
			vscode.window.showErrorMessage("No node selected.");
			return;
		}

		const { objectRef, attr } = node;

		// This command is only invoked on the tree item pointing to the array itself, not an element of the array.
		assert(objectRef !== undefined && typeof(objectRef) === 'object');
		assert(attr !== undefined && typeof(attr) === 'string');

		if (objectRef[attr] === undefined) {
			objectRef[attr] = [];
		}

		objectRef[attr].push('');
		node.tree!.refresh();
	});

	const RemoveElement = vscode.commands.registerCommand("coglens.RemoveElement", async (node: TreeNode | undefined) => {
		if (node === undefined) {
			vscode.window.showErrorMessage("No node selected.");
			return;
		}

		const { objectRef, attr } = node;

		assert(objectRef !== undefined);
		assert(attr !== undefined);

		if (Array.isArray(objectRef)) {
			assert(typeof(attr) === 'number');
			objectRef.splice(attr, 1);
		}
		else if (typeof(objectRef) === 'object') {
			assert(typeof(attr) === 'string');
			objectRef[attr].pop();
		}
		else {
			assert(false, `Type of objectRef is ${typeof(objectRef)} instead of Object or Array`);
		}

		node.tree!.refresh();
	});

	const AddDefaultCompileInfo = vscode.commands.registerCommand('coglens.AddDefaultCompileInfo', async () => {
		if (compileManager.compilationInfo.defaultCompileInfo === undefined) {
			compileManager.compilationInfo.defaultCompileInfo = {
				"compilerName": compileManager.compilerCache.compilerNames.at(0) ?? '',
				"defines": [],
				"includes": [],
				"args": [],
			};
		}

		infoTreeProvider.refresh();
	});

	const AddCompiler = vscode.commands.registerCommand('coglens.AddCompiler', async () => {
		// Get compiler executable
		const exeUris = await vscode.window.showOpenDialog({
			canSelectMany: false,
			openLabel: 'Select Compiler Executable',
			filters: { 'Executables': ['exe', '*'] }
		});

		if (!exeUris || exeUris.length === 0) {
			return;
		}

		const exeUri = exeUris[0];

		// Detect compiler type by executable
		const compiler = getCompilerByExe(exeUri.fsPath);
		if (compiler === undefined) {
			window.showErrorMessage(`Could not detect compiler type for ${exeUri.fsPath}.`);
			return;
		}

		// Get compiler name
		let name: string | undefined = path.basename(exeUri.fsPath, path.extname(exeUri.fsPath));
		do {
			name = await vscode.window.showInputBox({
				prompt: 'Enter a name for this compiler',
				value: name
			});

			if (name === undefined) {
				return;
			}

			name = name.trim();

			if (compileManager.compilerCache.hasCompiler(name)) {
				window.showWarningMessage(`Compiler '${name}' already exists.`);
				name = undefined;
			}

		} while(name === undefined);

		// Generate default compiler info
		const info = compiler.baseCompilerInfo(name, exeUri.fsPath);

		// Add to cache
		compileManager.compilerCache.createCompiler(info);
		compilerTreeProvider.refresh();
	});

	context.subscriptions.push(
		GetInput,
		GetFile,
		ClearInput,
		CopyText,
		AddElement,
		RemoveElement,
		AddDefaultCompileInfo,
		AddCompiler
	);
}

function createCompilerTreeView(context: ExtensionContext, cache: CompilerCache): CompilerTreeProvider {
	const treeProvider = new CompilerTreeProvider(cache);
	const treeView = window.createTreeView('coglens.compilers', { treeDataProvider: treeProvider });

	treeView.onDidChangeCheckboxState(async (event) => {
		const [[node]] = event.items;
		const { objectRef, attr } = node;

		assert(objectRef !== undefined && attr !== undefined);
		assert(typeof(objectRef[attr]) === 'boolean' || typeof(objectRef[attr]) === 'undefined');

		objectRef[attr] = !(objectRef[attr] ?? false);
		treeProvider.refresh();
	});

	context.subscriptions.push(treeView);

	return treeProvider;
}

function createCompilationInfoTreeView(context: ExtensionContext, compilationInfo: CompileInfoDatabase): CompilationInfoTreeProvider {
	const treeProvider = new CompilationInfoTreeProvider(compilationInfo);
	const treeView = window.createTreeView('coglens.compileinfo', { treeDataProvider: treeProvider });

	context.subscriptions.push(treeView);

	return treeProvider;
}

export async function activate(context: ExtensionContext): Promise<void> {
	const compileManager = new CompileManager();
	const provider = new AsmProvider(compileManager);

	const compilerTreeProvider = createCompilerTreeView(context, compileManager.compilerCache);
	const infoTreeProvider = createCompilationInfoTreeView(context, compileManager.compilationInfo);

	setupCommands(context, compileManager, compilerTreeProvider, infoTreeProvider);

	// Use CMake API to fetch build info for each file in the project
	const cmakeMonitor = new CmakeMonitor();
	const compileInfoRegistration = cmakeMonitor.onNewCompilationInfo(infoArray => {
		for (let [file, prelimInfo] of infoArray) {
			// Detect compiler type by executable
			const compiler = getCompilerByExe(prelimInfo.compilerPath.fsPath);

			if (compiler === undefined) {
				window.showErrorMessage(`Could not detect compiler type for ${file.fsPath}.`);
				continue;
			}

			// Create base compiler info
			const compilerName = 'CMake: ' + path.basename(prelimInfo.compilerPath.fsPath);
			const compilerInfo = compiler.baseCompilerInfo(compilerName, prelimInfo.compilerPath.fsPath);

			if (!compileManager.compilerCache.hasCompiler(compilerInfo.name)) {
				compileManager.compilerCache.createCompiler(compilerInfo);
			}

			// Create file compilation info
			const info: CompilationInfo = {
				compilerName: compilerInfo.name,
				...prelimInfo,
			};

			compileManager.setCompilationInfo(file, info);
		}

		compilerTreeProvider.refresh();
		infoTreeProvider.refresh();
	});

	cmakeMonitor.initCmakeApi();

	// Register content provider for the 'assembly' scheme
	const asmProviderRegistration = workspace.registerTextDocumentContentProvider(AsmProvider.scheme, provider);

	const asmDefRegistration = AsmDefinitionProvider.register(provider);

	// Register main command. This will create a URI with the 'assembly' scheme, open the document,
	// and display it an an editor to the right.
	const commandRegistration = commands.registerTextEditorCommand('coglens.Disassemble', async srcEditor => {
		const asmUri = getAsmUri(srcEditor.document.uri);

		await provider.updateAsmDocument(asmUri);

		const options: TextDocumentShowOptions = {
			viewColumn: ViewColumn.Beside,
			preserveFocus: true,
		};

		window.showTextDocument(asmUri, options).then(asmEditor => {
			const decorator = new AsmDecorator(srcEditor, asmEditor, provider);
			// dirty way to get decorations work after showing assembly
			setTimeout(() => decorator.updateSelection(srcEditor), 500);
		});
	});

	context.subscriptions.push(
		provider,
		cmakeMonitor,
		compileInfoRegistration,
		asmProviderRegistration,
		asmDefRegistration,
		commandRegistration
	);
}
