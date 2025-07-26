import vscode from 'vscode';
import { workspace, window, commands, ExtensionContext, TextDocumentShowOptions, ViewColumn } from 'vscode';
import { AsmProvider, getAsmUri } from './asm-document/asm-provider';
import { AsmDefinitionProvider } from './asm-document/asm-definition-provider';
import { CompileManager, CompilationInfo } from './compile-database';
import { CmakeMonitor } from './buildsystems/cmake';
import { getCompilerByExe } from './compilers/compiler-map';
import path from 'path';
import * as logger from './logger';
import * as setup from './setup';

/*
TODO:
  - show compiler error log in the asm editor
    - requires an error state in the CompiledAssembly so the AsmDecorator knows to ignore the contents
  - objdump support (is this needed?)
  - Settings for binary ASM parsing
*/

export async function activate(context: ExtensionContext): Promise<void> {
	const compileManager = new CompileManager();
	const asmProvider = new AsmProvider(compileManager);
	const asmDefProvider = new AsmDefinitionProvider();

	const compilerTreeProvider = setup.createCompilerTreeView(context, compileManager.compilerCache);
	const infoTreeProvider = setup.createCompilationInfoTreeView(context, compileManager.compilationInfo);
	const globalOptionsTreeProvider = setup.createGlobalOptionsTreeView(context, compileManager);

	setup.setupCommands(context, compileManager, compilerTreeProvider, infoTreeProvider, globalOptionsTreeProvider);

	// Use CMake API to fetch build info for each file in the project
	const cmakeMonitor = new CmakeMonitor();
	const compileInfoRegistration = cmakeMonitor.onNewCompilationInfo(infoArray => {
		for (let [file, prelimInfo] of infoArray) {
			// Detect compiler type by executable
			const compiler = getCompilerByExe(prelimInfo.compilerPath.fsPath);

			if (compiler === undefined) {
				logger.logAndShowError(`Could not detect compiler type for ${file.fsPath}`);
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
	const asmProviderRegistration = workspace.registerTextDocumentContentProvider(AsmProvider.scheme, asmProvider);
	const asmDefRegistration = vscode.languages.registerDefinitionProvider({scheme: AsmProvider.scheme}, asmDefProvider);

	// Register main command. This will create a URI with the 'assembly' scheme, open the document,
	// and display it an an editor to the right.
	const commandRegistration = commands.registerTextEditorCommand('coglens.Disassemble', srcEditor => {
		const asmUri = getAsmUri(srcEditor.document.uri);

		const options: TextDocumentShowOptions = {
			viewColumn: ViewColumn.Beside,
			preserveFocus: true,
			preview: false,
		};

		window.showTextDocument(asmUri, options);
	});

	context.subscriptions.push(
		asmProvider,
		cmakeMonitor,
		compileInfoRegistration,
		asmProviderRegistration,
		asmDefRegistration,
		commandRegistration
	);
}
