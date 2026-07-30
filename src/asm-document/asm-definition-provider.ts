import { DefinitionProvider, TextDocument, Position, CancellationToken, ProviderResult, Definition, DefinitionLink, Location, Uri } from "vscode";
import { asmLineHasSource, type CompiledAssembly } from "./compiled-assembly.js";

// Provides "Go To Definition" support for ASM lines that go to the corresponding source line. This isn't ideal though
// since the default behavior is to open a new source editor unless the user has enabled "workbench.editor.revealIfOpen".
export class AsmDefinitionProvider implements DefinitionProvider {
	private readonly assemblyLookup: (uri: Uri) => CompiledAssembly | undefined;

	constructor(assemblyLookup: (uri: Uri) => CompiledAssembly | undefined) {
		this.assemblyLookup = assemblyLookup;
	}

	provideDefinition(document: TextDocument, position: Position, token: CancellationToken): ProviderResult<Definition | DefinitionLink[]> {
		const assembly = this.assemblyLookup(document.uri);
		if (assembly === undefined) {
			return undefined;
		}

		if (position.line >= assembly.lines.length) {
			return undefined;
		}

		const asmLine = assembly.lines[position.line];

		if (!asmLineHasSource(asmLine)) {
			return undefined;
		}

		return new Location(
			Uri.file(asmLine.source!.file!),
			new Position(asmLine.source!.line! - 1, asmLine.source!.column ?? 0)
		);
	}
}
