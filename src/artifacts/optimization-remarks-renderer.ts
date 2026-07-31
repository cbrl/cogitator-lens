import path from 'path';
import type {
	DisplayOptions,
	OptimizationRemarkCategory,
	RawArtifact,
	RenderedArtifact,
	RenderedArtifactLine,
} from '../types/index.js';
import {
	processRawGccOptRemarks,
	processRawLlvmOptRemarks,
} from '../vendor/lib/optimization-remarks.js';
import type { OptRemark } from '../vendor/static/panes/opt-view.interfaces.js';
import type { ArtifactRenderContext } from './artifact-definitions.js';
import { renderedArtifact } from './rendered-artifact.js';

export interface OptimizationRemark {
	readonly file?: string;
	readonly line?: number;
	readonly column?: number;
	readonly pass: string;
	readonly category: OptimizationRemarkCategory;
	readonly message: string;
}

export type OptimizationRemarksParser = (
	text: string,
	workingDirectory: string,
) => OptimizationRemark[];

export function optimizationRemarksRenderer(
	parser: OptimizationRemarksParser,
): (
	raw: RawArtifact,
	options: DisplayOptions,
	context: ArtifactRenderContext,
) => RenderedArtifact {
	return (raw, _options, context) =>
		renderOptimizationRemarks(raw, context, parser);
}

function renderOptimizationRemarks(
	raw: RawArtifact,
	context: ArtifactRenderContext,
	parser: OptimizationRemarksParser,
): RenderedArtifact {
	const remarks = parser(raw.text, raw.command.workingDirectory);
	const sourceFile = path.normalize(context.source.uri.fsPath);
	const sourceLines = splitSourceLines(context.source.text);
	const mappedRemarks = remarks.filter(remark =>
		remark.file !== undefined
		&& remark.line !== undefined
		&& remark.line >= 1
		&& remark.line <= sourceLines.length
		&& sameSourcePath(remark.file, sourceFile));
	const remarksByLine = new Map<number, OptimizationRemark[]>();
	for (const remark of mappedRemarks) {
		const lineRemarks = remarksByLine.get(remark.line!) ?? [];
		lineRemarks.push(remark);
		remarksByLine.set(remark.line!, lineRemarks);
	}

	const lines: RenderedArtifactLine[] = sourceLines.flatMap((text, index) => {
		const sourceLine = index + 1;
		const lineRemarks = remarksByLine.get(sourceLine) ?? [];
		const source = {
			file: sourceFile,
			line: sourceLine,
			column: 0,
			mainSource: true,
		} as const;
		return [
			...lineRemarks.map(remark => ({
				text: '',
				source: {
					...source,
					column: Math.max(0, Math.min(
						text.length,
						(remark.column ?? 1) - 1,
					)),
				},
				decorations: [{
					kind: 'optimization-remark' as const,
					category: remark.category,
					text: `[${remark.category}] ${remark.pass}: ${remark.message}`,
				}],
			})),
			{ text, source },
		];
	});
	const categories = Object.fromEntries(
		[...new Set(mappedRemarks.map(remark => remark.category))]
			.sort()
			.map(category => [
				category,
				mappedRemarks.filter(remark => remark.category === category).length,
			]),
	);
	return renderedArtifact(raw, lines, {
		remarkCount: mappedRemarks.length,
		omittedRemarkCount: remarks.length - mappedRemarks.length,
		categories,
	});
}

export function parseClangOptimizationRemarks(
	text: string,
	workingDirectory: string,
): OptimizationRemark[] {
	return processRawLlvmOptRemarks(text).map(remark =>
		normalizeRemark(remark, workingDirectory));
}

export function parseGccOptimizationRemarks(
	text: string,
	workingDirectory: string,
): OptimizationRemark[] {
	return processRawGccOptRemarks(text).map(remark =>
		normalizeRemark(remark, workingDirectory));
}

function normalizeRemark(
	remark: OptRemark,
	workingDirectory: string,
): OptimizationRemark {
	const location = remark.DebugLoc.File
		&& remark.DebugLoc.Line > 0
		&& remark.DebugLoc.Column >= 0
		? {
			file: sourcePath(remark.DebugLoc.File, workingDirectory),
			line: remark.DebugLoc.Line,
			column: remark.DebugLoc.Column,
		}
		: {};
	return {
		...location,
		pass: remark.Pass || inferGccPass(remark.displayString),
		category: remark.optType.toLowerCase() as OptimizationRemarkCategory,
		message: remark.displayString || remark.Name || remark.Pass,
	};
}

function inferGccPass(message: string): string {
	if (/\b(?:inline|inlined|inlining)\b/i.test(message)) {
		return 'inliner';
	}
	if (/\b(?:vector|vectorized|vectorization)\b/i.test(message)) {
		return 'vectorizer';
	}
	if (/\bloop\b/i.test(message)) {
		return 'loop';
	}
	if (/\b(?:ipa|interprocedural)\b/i.test(message)) {
		return 'ipa';
	}
	if (/\bomp\b/i.test(message)) {
		return 'omp';
	}
	return 'gcc';
}

function sourcePath(filename: string, workingDirectory: string): string {
	return path.normalize(path.isAbsolute(filename)
		? filename
		: path.resolve(workingDirectory, filename));
}

function splitSourceLines(text: string): string[] {
	return text.split(/\r\n|\n|\r/);
}

function sameSourcePath(left: string, right: string): boolean {
	const normalizedLeft = path.resolve(left);
	const normalizedRight = path.resolve(right);
	return process.platform === 'win32'
		? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
		: normalizedLeft === normalizedRight;
}
