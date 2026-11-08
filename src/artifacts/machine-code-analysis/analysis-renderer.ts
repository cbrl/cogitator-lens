import { resolveCompilerPath } from '../../file-identity.js';
import { isRecord } from '../../common.js';
import type {
	ArtifactFold,
	ArtifactSymbol,
	DisplayOptions,
	RawArtifact,
	RenderedArtifactLine,
	RenderedTextArtifact,
} from '../../types/index.js';
import type { ArtifactRenderContext } from '../core/artifact-contracts.js';
import { renderedArtifact } from '../core/rendered-artifact.js';
import type { AnalysisSource } from './analysis-regions.js';

/** The header of a code region in the llvm-mca report: `[0] Code Region - name`. */
const regionHeader = /^\[(\d+)\] Code Region - (.*)$/u;
/** The header of a table with one row for each instruction of the region, in their order. */
const instructionTableHeader = /\bInstructions:\s*$/u;

/** The sources of the instructions of each region, from the producer data. */
function regionSources(data: unknown): readonly (readonly (AnalysisSource | null)[])[] {
	if (!isRecord(data) || !Array.isArray(data.regions)) {
		return [];
	}
	return data.regions.map((region: unknown) =>
		isRecord(region) && Array.isArray(region.sources)
			? region.sources.map((source: unknown) =>
					isRecord(source) && typeof source.file === 'string' && typeof source.line === 'number'
						? { file: source.file, line: source.line }
						: null,
				)
			: [],
	);
}

/**
 * Shows the llvm-mca report. Each code region is one function: it is a symbol of the listing, and
 * it folds. The rows of the instruction tables of a region map to the source lines of their
 * instructions, so the editor connects them with the source. A table whose row count differs from
 * the instruction count of its region has no mapping, because llvm-mca skipped or added a row.
 */
export function renderMachineCodeAnalysis(
	raw: RawArtifact,
	_options: DisplayOptions,
	_context: ArtifactRenderContext,
): RenderedTextArtifact {
	const sources = regionSources(raw.producerData);
	const text = raw.text.replace(/\s+$/u, '');
	const lines: RenderedArtifactLine[] = text.split(/\r?\n/u).map((line) => ({ text: line }));
	const symbols: ArtifactSymbol[] = [];
	let region: number | undefined;
	let rows: number[] | undefined;
	let mappedRows = 0;
	const mapRows = (): void => {
		const regionLines = region === undefined ? undefined : sources[region];
		if (rows && regionLines && rows.length === regionLines.length) {
			rows.forEach((row, index) => {
				const source = regionLines[index];
				if (source) {
					lines[row] = {
						...lines[row],
						source: { file: resolveCompilerPath(source.file, raw.command.cwd), line: source.line },
					};
					mappedRows++;
				}
			});
		}
		rows = undefined;
	};
	lines.forEach((line, index) => {
		const header = regionHeader.exec(line.text);
		if (header) {
			mapRows();
			region = Number(header[1]);
			symbols.push({ name: header[2].trim(), line: index });
		} else if (instructionTableHeader.test(line.text)) {
			mapRows();
			rows = [];
		} else if (rows && !line.text.trim()) {
			mapRows();
		} else if (rows) {
			rows.push(index);
		}
	});
	mapRows();
	const folds: ArtifactFold[] = symbols.map((symbol, index) => ({
		startLine: symbol.line,
		endLine: (symbols[index + 1]?.line ?? lines.length) - 1,
	}));
	return {
		...renderedArtifact(raw, lines, { regionCount: symbols.length, mappedRowCount: mappedRows }),
		symbols,
		folds: folds.filter((fold) => fold.endLine > fold.startLine),
	};
}
