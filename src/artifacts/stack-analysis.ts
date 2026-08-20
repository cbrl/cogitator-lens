import path from 'path';
import type {
	DisplayOptions,
	RawArtifact,
	RenderedArtifact,
	StackUsageQualifier,
} from '../types/index.js';
import type { ArtifactProducer } from '../toolchains/toolchain-map.js';
import type { CompilerOutputSpec } from '../toolchains/toolchain-backend.js';
import type { ArtifactRenderContext } from './artifact-definitions.js';
import { compilerOutputProducer } from './compiler-output-producer.js';
import {
	type AnalysisParserDiagnostic,
	renderAnalysisSource,
	sameSourcePath,
} from './analysis-source-renderer.js';

export interface StackUsageEntry {
	readonly sourceUri?: string;
	readonly sourceLine?: number;
	readonly sourceColumn?: number;
	readonly functionName: string;
	readonly value: number;
	readonly unit: 'bytes' | 'vm-slots';
	readonly qualifier: StackUsageQualifier;
}

export interface StackUsageParseResult {
	readonly entries: readonly StackUsageEntry[];
	readonly diagnostics: readonly AnalysisParserDiagnostic[];
}

export const nativeStackUsageOutput: CompilerOutputSpec = Object.freeze({
	outputFilename: 'output.su',
	arguments: (_outputFile: string, temporaryDirectory: string) => [
		'-c',
		'-fstack-usage',
		'-o',
		path.join(temporaryDirectory, 'output.o'),
	],
});

export const clangClStackUsageOutput: CompilerOutputSpec = Object.freeze({
	outputFilename: 'output.su',
	arguments: (_outputFile: string, temporaryDirectory: string) => [
		'/c',
		'/clang:-fstack-usage',
		`/Fo${path.join(temporaryDirectory, 'output.obj')}`,
	],
});

export const nativeStackAnalysisProducer: ArtifactProducer = compilerOutputProducer(
	'stack-analysis',
	nativeStackUsageOutput,
);

export const clangClStackAnalysisProducer: ArtifactProducer = compilerOutputProducer(
	'stack-analysis',
	clangClStackUsageOutput,
);

/** Parse GCC/Clang's documented .su records without assuming POSIX paths. */
export function parseStackUsage(
	text: string,
	workingDirectory: string,
): StackUsageParseResult {
	const entries: StackUsageEntry[] = [];
	const diagnostics: AnalysisParserDiagnostic[] = [];
	const seen = new Set<string>();
	const lines = text.split(/\r\n|\n|\r/);

	for (const [index, rawLine] of lines.entries()) {
		const record = rawLine.trim();
		if (!record) {
			continue;
		}
		const parsed = parseStackUsageRecord(record, workingDirectory);
		if (typeof parsed === 'string') {
			diagnostics.push({
				line: index + 1,
				message: parsed,
				text: rawLine,
			});
			continue;
		}
		const key = JSON.stringify(parsed);
		if (!seen.has(key)) {
			seen.add(key);
			entries.push(parsed);
		}
	}

	return { entries, diagnostics };
}

function parseStackUsageRecord(
	record: string,
	workingDirectory: string,
): StackUsageEntry | string {
	const fields = /^(.*?)[\t ]+([+-]?\d+)[\t ]+(dynamic(?:[\t , -]+bounded)?|static)\s*$/i.exec(record);
	if (!fields) {
		return 'expected a location, non-negative integer size, and stack qualifier';
	}

	const value = Number(fields[2]);
	if (!Number.isSafeInteger(value) || value < 0) {
		return 'stack size must be a non-negative safe integer';
	}
	const qualifier = normalizeNativeQualifier(fields[3]);
	if (!qualifier) {
		return `unknown stack qualifier: ${fields[3]}`;
	}

	// Greedy matching deliberately selects the rightmost :line:column: pair.
	// That leaves a Windows drive prefix in the path and C++ punctuation in the
	// function name instead of treating either colon as a field boundary.
	const location = /^(.*):(\d+):(\d+):(.*)$/.exec(fields[1]);
	if (!location) {
		return 'expected source:line:column:function before the stack size';
	}
	const sourceLine = Number(location[2]);
	const sourceColumn = Number(location[3]);
	const functionName = location[4].trim();
	if (
		!Number.isSafeInteger(sourceLine)
		|| sourceLine < 1
		|| !Number.isSafeInteger(sourceColumn)
		|| sourceColumn < 0
		|| !functionName
	) {
		return 'source line, column, and function name must be valid';
	}
	const filename = location[1].trim();
	if (!filename) {
		return 'source path must not be empty';
	}

	return {
		sourceUri: resolveSourcePath(filename, workingDirectory),
		sourceLine,
		sourceColumn,
		functionName,
		value,
		unit: 'bytes',
		qualifier,
	};
}

function resolveSourcePath(filename: string, workingDirectory: string): string {
	if (path.win32.isAbsolute(filename)) {
		return path.win32.normalize(filename);
	}
	return path.normalize(path.isAbsolute(filename)
		? filename
		: path.resolve(workingDirectory, filename));
}

function normalizeNativeQualifier(
	value: string,
): 'static' | 'dynamic' | 'dynamic-bounded' | undefined {
	switch (value.trim().toLowerCase().replace(/[\s,-]+/g, '-')) {
		case 'static': return 'static';
		case 'dynamic': return 'dynamic';
		case 'dynamic-bounded': return 'dynamic-bounded';
		default: return undefined;
	}
}

export function renderNativeStackAnalysis(
	raw: RawArtifact,
	_options: DisplayOptions,
	context: ArtifactRenderContext,
): RenderedArtifact {
	const parsed = parseStackUsage(raw.text, raw.command.workingDirectory);
	return renderStackUsage(raw, context, parsed.entries, parsed.diagnostics);
}

export function renderStackUsage(
	raw: RawArtifact,
	context: ArtifactRenderContext,
	entries: readonly StackUsageEntry[],
	parserDiagnostics: readonly AnalysisParserDiagnostic[] = [],
	preamble: readonly string[] = [],
	defaultUnit: StackUsageEntry['unit'] = 'bytes',
): RenderedArtifact {
	const sourceFile = path.normalize(context.source.uri.fsPath);
	const sourceLineCount = context.source.text.split(/\r\n|\n|\r/).length;
	const unmappedEntryCount = entries.filter(entry =>
		entry.sourceUri === undefined
		|| entry.sourceLine === undefined
		|| entry.sourceLine < 1
		|| entry.sourceLine > sourceLineCount
		|| !sameSourcePath(entry.sourceUri, sourceFile)
	).length;
	const unit = entries[0]?.unit ?? defaultUnit;
	const totalKnownFrame = entries.reduce((total, entry) => total + entry.value, 0);
	const largestFrame = entries.reduce((largest, entry) => Math.max(largest, entry.value), 0);
	const dynamicFrameCount = entries.filter(entry =>
		entry.qualifier === 'dynamic' || entry.qualifier === 'dynamic-bounded').length;

	return renderAnalysisSource(
		raw,
		context,
		entries.map(entry => ({
			sourceUri: entry.sourceUri,
			sourceLine: entry.sourceLine,
			sourceColumn: entry.sourceColumn,
			annotation: {
				kind: 'stack-usage',
				functionName: entry.functionName,
				value: entry.value,
				unit: entry.unit,
				qualifier: entry.qualifier,
			},
		})),
		{
			preamble,
			includeUnmappedEntries: true,
			parserDiagnostics,
			metrics: {
				functionCount: entries.length,
				largestFrame,
				largestFrameUnit: unit,
				totalKnownFrame,
				totalKnownFrameUnit: unit,
				dynamicFrameCount,
				unmappedEntryCount,
			},
		},
	);
}
