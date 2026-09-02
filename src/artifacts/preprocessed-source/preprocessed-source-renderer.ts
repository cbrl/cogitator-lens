import path from 'node:path';
import type { DisplayOptions, RawArtifact, RenderedTextArtifact, RenderedArtifactLine } from '../../types/index.js';
import type { ArtifactRenderContext } from '../core/artifact-contracts.js';
import { renderedArtifact } from '../core/rendered-artifact.js';

const lineMarker = /^\s*#(?:\s*line)?\s+(\d+)\s+"((?:\\.|[^"])*)"(?:\s+.*)?$/;

export function renderPreprocessedSource(
	raw: RawArtifact,
	options: DisplayOptions,
	context: ArtifactRenderContext,
): RenderedTextArtifact {
	const sourceFile = path.normalize(context.source.uri.fsPath);
	let logicalFile = sourceFile;
	let logicalLine = 1;
	const lines: RenderedArtifactLine[] = [];
	const markerLines: number[] = [];

	for (const text of splitLines(raw.text)) {
		const marker = lineMarker.exec(text);
		if (marker) {
			logicalLine = Number.parseInt(marker[1], 10);
			logicalFile = resolveMarkerPath(decodeMarkerFilename(marker[2]), raw.command.workingDirectory);
			markerLines.push(lines.length);
			lines.push({ text });
			continue;
		}

		const mainSource = sameFile(logicalFile, sourceFile);
		if (options.showIncludedFiles || mainSource) {
			lines.push({
				text,
				source: isLocalFilename(logicalFile)
					? {
							file: logicalFile,
							line: logicalLine,
							column: 0,
							mainSource,
						}
					: undefined,
			});
		}
		logicalLine++;
	}

	const folds = options.showIncludedFiles
		? markerLines.flatMap((startLine, index) => {
				const endLine = (markerLines[index + 1] ?? lines.length) - 1;
				return endLine > startLine ? [{ startLine, endLine }] : [];
			})
		: [];
	const includedFiles = new Set(
		lines.flatMap((line) => (line.source?.file && !line.source.mainSource ? [line.source.file] : [])),
	);
	return {
		...renderedArtifact(raw, lines, {
			includedFileCount: includedFiles.size,
			lineMarkerCount: markerLines.length,
		}),
		folds,
	};
}

export function parsePreprocessorLineMarker(
	text: string,
	workingDirectory: string,
): { line: number; file: string } | undefined {
	const marker = lineMarker.exec(text);
	if (!marker) {
		return undefined;
	}
	return {
		line: Number.parseInt(marker[1], 10),
		file: resolveMarkerPath(decodeMarkerFilename(marker[2]), workingDirectory),
	};
}

function resolveMarkerPath(filename: string, workingDirectory: string): string {
	if (!isLocalFilename(filename)) {
		return filename;
	}
	return path.normalize(path.isAbsolute(filename) ? filename : path.resolve(workingDirectory, filename));
}

function decodeMarkerFilename(filename: string): string {
	return filename.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

function isLocalFilename(filename: string): boolean {
	return filename !== '' && !(filename.startsWith('<') && filename.endsWith('>'));
}

function sameFile(left: string, right: string): boolean {
	const normalizedLeft = path.normalize(left);
	const normalizedRight = path.normalize(right);
	return process.platform === 'win32'
		? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
		: normalizedLeft === normalizedRight;
}

function splitLines(text: string): string[] {
	const lines = text.split(/\r\n|\n|\r/);
	if (lines.at(-1) === '') {
		lines.pop();
	}
	return lines;
}
