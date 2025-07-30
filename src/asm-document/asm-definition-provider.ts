import { DefinitionProvider, Disposable, languages, TextDocument, Position, CancellationToken, ProviderResult, Definition, DefinitionLink, Location, Uri, window } from "vscode";
import { CompiledAssembly } from "./compiled-assembly";

// Provides "Go To Definition" support for ASM lines that go to the corresponding source line. This isn't ideal though
// since the default behavior is to open a new source editor unless the user has enabled "workbench.editor.revealIfOpen".
export class AsmDefinitionProvider implements DefinitionProvider {
	provideDefinition(document: TextDocument, position: Position, token: CancellationToken): ProviderResult<Definition | DefinitionLink[]> {
		if (!(document instanceof CompiledAssembly)) {
			throw new Error("Expected asmDoc to be an instance of CompiledAssembly");
		}

		if (document.lines instanceof Error) {
			return;
		}

		if (position.line >= document.lines.length) {
			return undefined;
		}

		const asmLine = document.lines[position.line];

		// eslint-disable-next-line eqeqeq
		if (asmLine.source?.line == null || asmLine.source?.file == null) {
			return undefined;
		}

		return new Location(
			Uri.file(asmLine.source!.file!),
			new Position(document.lines[position.line].source!.line! - 1, asmLine.source!.column ?? 0)
		);
	}
}
