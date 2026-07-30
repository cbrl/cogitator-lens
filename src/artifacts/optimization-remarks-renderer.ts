import path from 'path';
import type {
	DisplayOptions,
	RawArtifact,
	RenderedArtifact,
} from '../types/index.js';
import type { ToolchainBackend } from '../toolchains/toolchain-backend.js';
import {
	processRawGccOptRemarks,
	processRawLlvmOptRemarks,
} from '../vendor/lib/optimization-remarks.js';
import type { OptRemark } from '../vendor/static/panes/opt-view.interfaces.js';
import { renderedArtifact } from './rendered-artifact.js';

export type OptimizationRemarkCategory =
	| 'passed'
	| 'missed'
	| 'analysis';

export interface OptimizationRemark {
	readonly file?: string;
	readonly line?: number;
	readonly column?: number;
	readonly pass: string;
	readonly category: OptimizationRemarkCategory;
	readonly message: string;
}

export function renderOptimizationRemarks(
	raw: RawArtifact,
	_options: DisplayOptions,
	backend: ToolchainBackend,
): RenderedArtifact {
	const remarks = backend.profile.kind === 'gcc'
		? parseGccOptimizationRemarks(raw.text, raw.command.workingDirectory)
		: parseClangOptimizationRemarks(raw.text, raw.command.workingDirectory);
	const lines = remarks.map(remark => {
		const hasLocation = remark.file !== undefined
			&& remark.line !== undefined
			&& remark.column !== undefined;
		return {
			text: `${hasLocation ? `${remark.file}:${remark.line}:${remark.column} ` : ''}`
				+ `[${remark.category}] ${remark.pass}: ${remark.message}`,
			source: hasLocation
				? {
					file: remark.file!,
					line: remark.line!,
					column: Math.max(0, remark.column! - 1),
				}
				: undefined,
		};
	});
	const categories = Object.fromEntries(
		[...new Set(remarks.map(remark => remark.category))]
			.sort()
			.map(category => [
				category,
				remarks.filter(remark => remark.category === category).length,
			]),
	);
	return renderedArtifact(raw, lines, {
		remarkCount: remarks.length,
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
