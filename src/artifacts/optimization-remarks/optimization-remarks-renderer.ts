import path from 'path';
import type {
	DisplayOptions,
	OptimizationRemarkCategory,
	RawArtifact,
	RenderedTextArtifact,
} from '../../types/index.js';
import type { OptRemark } from '../../vendor/static/panes/opt-view.interfaces.js';
import type { ArtifactRenderContext } from '../core/artifact-contracts.js';
import { renderAnalysisSource } from '../analysis/analysis-source-renderer.js';
import { sameLocalFile } from '../../local-file-identity.js';

export interface OptimizationRemark {
	readonly file?: string;
	readonly line?: number;
	readonly column?: number;
	readonly pass: string;
	readonly category: OptimizationRemarkCategory;
	readonly message: string;
}

export type OptimizationRemarksParser = (text: string, workingDirectory: string) => OptimizationRemark[];

export function optimizationRemarksRenderer(
	parser: OptimizationRemarksParser,
): (raw: RawArtifact, options: DisplayOptions, context: ArtifactRenderContext) => RenderedTextArtifact {
	return (raw, _options, context) => renderOptimizationRemarks(raw, context, parser);
}

function renderOptimizationRemarks(
	raw: RawArtifact,
	context: ArtifactRenderContext,
	parser: OptimizationRemarksParser,
): RenderedTextArtifact {
	const remarks = parser(raw.text, raw.command.workingDirectory);
	const sourceFile = path.normalize(context.source.uri.fsPath);
	const sourceLineCount = context.source.text.split(/\r\n|\n|\r/).length;
	const mappedRemarks = remarks.filter(
		(remark) =>
			remark.file !== undefined &&
			remark.line !== undefined &&
			remark.line >= 1 &&
			remark.line <= sourceLineCount &&
			sameLocalFile(remark.file, sourceFile),
	);
	const categoryCount = (category: OptimizationRemarkCategory): number =>
		mappedRemarks.filter((remark) => remark.category === category).length;
	return renderAnalysisSource(
		raw,
		context,
		mappedRemarks.map((remark) => ({
			sourceUri: remark.file,
			sourceLine: remark.line,
			sourceColumn: remark.column,
			annotation: {
				kind: 'optimization-remark',
				category: remark.category,
				message: `${remark.pass}: ${remark.message}`,
				text: `[${remark.category}] ${remark.pass}: ${remark.message}`,
				style: `optimization-${remark.category}`,
			},
		})),
		{
			metrics: {
				remarkCount: mappedRemarks.length,
				omittedRemarkCount: remarks.length - mappedRemarks.length,
				passedRemarkCount: categoryCount('passed'),
				missedRemarkCount: categoryCount('missed'),
				analysisRemarkCount: categoryCount('analysis'),
			},
		},
	);
}

export function normalizeOptimizationRemark(remark: OptRemark, workingDirectory: string): OptimizationRemark {
	const location =
		remark.DebugLoc.File && remark.DebugLoc.Line > 0 && remark.DebugLoc.Column >= 0
			? {
					file: sourcePath(remark.DebugLoc.File, workingDirectory),
					line: remark.DebugLoc.Line,
					column: remark.DebugLoc.Column,
				}
			: {};
	return {
		...location,
		pass: remark.Pass || inferOptimizationPass(remark.displayString),
		category: remark.optType.toLowerCase() as OptimizationRemarkCategory,
		message: remark.displayString || remark.Name || remark.Pass,
	};
}

function inferOptimizationPass(message: string): string {
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
	return path.normalize(path.isAbsolute(filename) ? filename : path.resolve(workingDirectory, filename));
}
