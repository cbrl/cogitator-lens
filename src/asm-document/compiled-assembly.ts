import { Uri } from 'vscode';
import { ParsedAsmResultLine } from '../parsers/asmresult.interfaces';
import { UriMap, UriSet } from '../uri-containers';
import path from 'path';

export class CompiledAssembly {
    public readonly srcUri: Uri;
    public readonly asmUri: Uri;

	/**
	 * Set of all source documents referenced by this assembly
	 */
	public readonly allReferencedSrcUris: UriSet = new UriSet();

    public readonly lines: ParsedAsmResultLine[] = [];

    // Mapping of source line to assembly line for each source file: file -> (source line -> ASM line)
    private readonly mappings = new UriMap<Map<number, number[]>>();

    constructor(srcUri: Uri, asmUri: Uri, lines: ParsedAsmResultLine[]) {
        this.srcUri = srcUri;
        this.asmUri = asmUri;
        this.lines = lines;
        this.mapLines();
    }

    /**
     * Gets the textual content of the assembly document.
     */
    public getContent(): string {
        if (this.lines instanceof Error) {
            return this.lines.message;
        }
        return this.lines.map(line => line.text).join('\n');
    }

	public getSourceToAsmLineMapping(file: Uri): Map<number, number[]> | undefined {
		return this.mappings.get(file);
	}

	public getSourceLinesForAsmLine(file: Uri, asmLineIndex: number): number[] | undefined {
		return this.mappings.get(file)?.get(asmLineIndex);
	}

	private mapLines() {
		if (this.lines instanceof Error) {
			return;
		}

		this.lines.forEach((line, index) => {
			if (!this.asmLineHasSource(line)) {
				return;
			}

			const sourceUri = Uri.file(path.normalize(line.source!.file!));
			const sourceLine = line.source!.line! - 1;

			this.allReferencedSrcUris.add(sourceUri);

			let lineMap = this.mappings.get(sourceUri);
			if (lineMap === undefined) {
				lineMap = new Map();
				this.mappings.set(sourceUri, lineMap);
			}
			if (lineMap.get(sourceLine) === undefined) {
				lineMap.set(sourceLine, []);
			}
			lineMap.get(sourceLine)!.push(index);
		});
	}

    private asmLineHasSource(asmLine: ParsedAsmResultLine) {
        // eslint-disable-next-line eqeqeq
        return (asmLine.source?.file != null && asmLine.source?.line != null); //checks null or undefined
    }
}
