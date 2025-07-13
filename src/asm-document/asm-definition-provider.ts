import { DefinitionProvider, Disposable, languages, TextDocument, Position, CancellationToken, ProviderResult, Definition, DefinitionLink, Location, Uri, window } from "vscode";
import { AsmProvider } from "./asm-provider";

// Provides "Go To Definition" support for ASM lines that go to the corresponding source line. This isn't ideal though
// since the default behavior is to open a new source editor unless the user has enabled "workbench.editor.revealIfOpen".
export class AsmDefinitionProvider implements DefinitionProvider {
	private asmProvider: AsmProvider;

	constructor(provider: AsmProvider) {
		this.asmProvider = provider;
	}

	static register(provider: AsmProvider): Disposable {
		return languages.registerDefinitionProvider(
			{scheme: AsmProvider.scheme},
			new AsmDefinitionProvider(provider)
		);
	}

	provideDefinition(document: TextDocument, position: Position, token: CancellationToken): ProviderResult<Definition | DefinitionLink[]> {
		// Document should already be compiled and available if querying a definition on it
		const asmDoc = this.asmProvider.provideAsmDocument(document.uri);

		if (position.line >= asmDoc.lines.length) {
			return undefined;
		}

		const asmLine = asmDoc.lines[position.line];

		// eslint-disable-next-line eqeqeq
		if (asmLine.source?.line == null || asmLine.source?.file == null) {
			return undefined;
		}

		return new Location(
			Uri.file(asmLine.source!.file!),
			new Position(asmDoc.lines[position.line].source!.line! - 1, asmLine.source!.column ?? 0)
		);
	}
}
