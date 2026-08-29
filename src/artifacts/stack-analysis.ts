import path from 'path';
import type {
	DisplayOptions,
	RawArtifact,
	RenderedTextArtifact,
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
		// GCC does not emit a .su file for an LTO object. CMake can add -flto
		// through INTERPROCEDURAL_OPTIMIZATION, so force ordinary per-TU codegen.
		'-fno-lto',
		'-o',
		path.join(temporaryDirectory, 'output.o'),
	],
});

export const clangClStackUsageOutput: CompilerOutputSpec = Object.freeze({
	outputFilename: 'output.su',
	arguments: (_outputFile: string, temporaryDirectory: string) => [
		'/c',
		'/clang:-fstack-usage',
		'/clang:-fno-lto',
		// LLVM only includes a source line in .su records when the function has
		// debug metadata. Line tables are sufficient and avoid full debug info.
		'/clang:-gline-tables-only',
		// Clang derives the .su path from its GCC-style -o option. /Fo controls
		// the object path in clang-cl mode, but is not consulted for this sidecar.
		'/clang:-o',
		`/clang:${path.join(temporaryDirectory, 'output.obj')}`,
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
	const fields = parseStackUsageFields(record);
	if (!fields) {
		return 'expected a location, non-negative integer size, and stack qualifier';
	}

	const value = Number(fields.value);
	if (!Number.isSafeInteger(value) || value < 0) {
		return 'stack size must be a non-negative safe integer';
	}
	const qualifier = normalizeNativeQualifier(fields.qualifier);
	if (!qualifier) {
		return `unknown stack qualifier: ${fields.qualifier}`;
	}

	const location = parseStackUsageLocation(fields.location, workingDirectory);
	const sourceLine = location.sourceLine;
	const sourceColumn = location.sourceColumn;
	const functionName = location.functionName;
	if (
		(sourceLine !== undefined
			&& (!Number.isSafeInteger(sourceLine) || sourceLine < 1))
		|| (sourceColumn !== undefined
			&& (!Number.isSafeInteger(sourceColumn) || sourceColumn < 0))
		|| !functionName
	) {
		return 'source line, column, and function name must be valid';
	}

	return {
		sourceUri: location.sourceUri,
		sourceLine,
		sourceColumn,
		functionName,
		value,
		unit: 'bytes',
		qualifier,
	};
}

interface NativeStackUsageFields {
	readonly location: string;
	readonly value: string;
	readonly qualifier: string;
}

/**
 * GCC 17 added a mangled-name column between the location and size. Reading
 * tab-separated records from the right accepts both versions without letting
 * whitespace in a demangled function signature change the field boundaries.
 */
function parseStackUsageFields(record: string): NativeStackUsageFields | undefined {
	const tabFields = record.split(/\t+/).map(field => field.trim());
	if (tabFields.length >= 3) {
		return {
			location: tabFields[0],
			value: tabFields.at(-2) ?? '',
			qualifier: tabFields.at(-1) ?? '',
		};
	}

	const fields = /^(.*?)[ ]+([+-]?\d+)[ ]+(dynamic(?:[ , -]+bounded)?|static)\s*$/i.exec(record);
	return fields
		? { location: fields[1], value: fields[2], qualifier: fields[3] }
		: undefined;
}

interface NativeStackUsageLocation {
	readonly sourceUri?: string;
	readonly sourceLine?: number;
	readonly sourceColumn?: number;
	readonly functionName: string;
}

function parseStackUsageLocation(
	value: string,
	workingDirectory: string,
): NativeStackUsageLocation {
	// GCC: source:line:column:function. Greedy matching selects the rightmost
	// numeric location, preserving a Windows drive prefix and C++ punctuation.
	const gcc = /^(.*):(\d+):(\d+):(.*)$/.exec(value);
	if (gcc) {
		return {
			sourceUri: resolveSourcePath(gcc[1].trim(), workingDirectory),
			sourceLine: Number(gcc[2]),
			sourceColumn: Number(gcc[3]),
			functionName: gcc[4].trim(),
		};
	}

	// Clang: source:line:function. LLVM deliberately omits the column.
	const clang = /^(.*):(\d+):(.*)$/.exec(value);
	if (clang) {
		return {
			sourceUri: resolveSourcePath(clang[1].trim(), workingDirectory),
			sourceLine: Number(clang[2]),
			functionName: clang[3].trim(),
		};
	}

	// Without line-table metadata LLVM emits source:function. Keep the record
	// as an unmapped result instead of turning valid stack data into a parser
	// diagnostic. The owned Clang flags normally prevent this fallback.
	const separator = value.lastIndexOf(':');
	if (separator > 1 && separator < value.length - 1) {
		return {
			sourceUri: resolveSourcePath(value.slice(0, separator).trim(), workingDirectory),
			functionName: value.slice(separator + 1).trim(),
		};
	}

	return { functionName: value.trim() };
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
): RenderedTextArtifact {
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
): RenderedTextArtifact {
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
