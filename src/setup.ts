import * as vscode from 'vscode';
import { CompileManager, CompilerCache, CompileInfoDatabase } from './compile-database';
import { CompilerTreeProvider } from './tree/compiler-tree';
import { CompilationInfoTreeProvider } from './tree/compilation-info-tree';
import { GlobalOptionsTreeProvider } from './tree/global-options-tree';
import { TreeNode } from './tree/treedata';
import { getCompilerByExe } from './compilers/compiler-map';
import * as logger from './logger';
import assert from 'assert';
import path from 'path';

export function setupCommands(
	context: vscode.ExtensionContext,
	compileManager: CompileManager,
	compilerTreeProvider: CompilerTreeProvider,
	infoTreeProvider: CompilationInfoTreeProvider,
	asmFilterTreeProvider: GlobalOptionsTreeProvider
) {
	const GetInput = vscode.commands.registerCommand('coglens.GetInput', async (node: TreeNode | undefined) => {
		if (node === undefined) {
			logger.logAndShowError("No node selected");
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
			logger.logAndShowError("No node selected");
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

	const PickCompiler = vscode.commands.registerCommand('coglens.PickCompiler', async (node: TreeNode | undefined) => {
		if (node === undefined) {
			logger.logAndShowError("No node selected");
			return;
		}

		const { objectRef, attr } = node;

		assert(objectRef !== undefined && attr !== undefined && typeof(objectRef[attr]) === 'string');

		const availableCompilers = compileManager.compilerCache.compilerNames;

		if (availableCompilers.length === 0) {
			logger.logAndShowError("No compilers available. Please add a compiler first.");
			return;
		}

		const currentCompiler = objectRef[attr] as string ?? '';

		// Create QuickPick items with current selection highlighted
		const quickPickItems: vscode.QuickPickItem[] = availableCompilers.map(name => ({
			label: name,
			description: name === currentCompiler ? '(current)' : undefined,
			picked: name === currentCompiler
		}));

		const selectedItem = await vscode.window.showQuickPick(quickPickItems, {
			placeHolder: 'Select a compiler',
			matchOnDescription: true,
			matchOnDetail: true,
		});

		if (selectedItem) {
			objectRef[attr] = selectedItem.label;
			node.tree!.refresh();
		}
	});

	const ClearInput = vscode.commands.registerCommand('coglens.ClearInput', async (node: TreeNode | undefined) => {
		if (node === undefined) {
			logger.logAndShowError("No node selected");
			return;
		}

		const { objectRef, attr } = node;

		assert(objectRef !== undefined && attr !== undefined && typeof(objectRef[attr]) === 'string');

		objectRef[attr] = '';
		node.tree!.refresh();
	});

	const CopyText = vscode.commands.registerCommand('coglens.CopyText', async (node: TreeNode | undefined) => {
		if (node === undefined) {
			logger.logAndShowError("No node selected");
			return;
		}

		vscode.env.clipboard.writeText(node.label!);
	});

	const AddElement = vscode.commands.registerCommand("coglens.AddElement", async (node: TreeNode | undefined) => {
		if (node === undefined) {
			logger.logAndShowError("No node selected");
			return;
		}

		const { objectRef, attr } = node;

		// This command is only invoked on the tree item pointing to the array itself, not an element of the array.
		assert(objectRef !== undefined && typeof(objectRef) === 'object');
		assert(attr !== undefined && typeof(attr) === 'string');

		if (objectRef[attr] === undefined) {
			objectRef[attr] = [];
		}

		const userInput = await vscode.window.showInputBox({placeHolder: 'Enter element value'});

		if (userInput === undefined || userInput === '') {
			return;
		}

		objectRef[attr].push(userInput);
		node.tree!.refresh();
	});

	const RemoveElement = vscode.commands.registerCommand("coglens.RemoveElement", async (node: TreeNode | undefined) => {
		if (node === undefined) {
			logger.logAndShowError("No node selected");
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
			title: 'Select Compiler Executable',
			canSelectMany: false,
		});

		if (!exeUris || exeUris.length === 0) {
			return;
		}

		const exeUri = exeUris[0];

		// Detect compiler type by executable
		const compiler = getCompilerByExe(exeUri.fsPath);
		if (compiler === undefined) {
			logger.logAndShowError(`Could not detect compiler type for ${exeUri.fsPath}`);
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
				logger.logAndShowWarning(`Compiler '${name}' already exists.`);
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
		PickCompiler,
		ClearInput,
		CopyText,
		AddElement,
		RemoveElement,
		AddDefaultCompileInfo,
		AddCompiler
	);
}

export function createCompilerTreeView(context: vscode.ExtensionContext, cache: CompilerCache): CompilerTreeProvider {
	const treeProvider = new CompilerTreeProvider(cache);
	const treeView = vscode.window.createTreeView('coglens.compilers', { treeDataProvider: treeProvider });

	treeView.onDidChangeCheckboxState((event) => {
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

export function createCompilationInfoTreeView(context: vscode.ExtensionContext, compilationInfo: CompileInfoDatabase): CompilationInfoTreeProvider {
	const treeProvider = new CompilationInfoTreeProvider(compilationInfo);
	const treeView = vscode.window.createTreeView('coglens.compileInfo', { treeDataProvider: treeProvider });

	context.subscriptions.push(treeView);

	return treeProvider;
}

export function createGlobalOptionsTreeView(context: vscode.ExtensionContext, compileManager: CompileManager): GlobalOptionsTreeProvider {
	const treeProvider = new GlobalOptionsTreeProvider(compileManager);
	const treeView = vscode.window.createTreeView('coglens.globalOptions', { treeDataProvider: treeProvider });

	treeView.onDidChangeCheckboxState((event) => {
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
