import type {
	DisplayOptions,
	RawArtifact,
	RenderedTextArtifact,
} from '../../types/index.js';
import type { ArtifactProducer } from '../../toolchains/toolchain-map.js';
import type { ArtifactRenderContext } from '../core/artifact-definitions.js';
import {
	renderStackUsage,
	type StackUsageEntry,
} from '../analysis/stack-analysis.js';

export interface PythonStackUsageRecord {
	readonly qualifiedName: string;
	readonly firstLine: number;
	readonly stackSize: number;
	readonly nesting: readonly string[];
}

export const pythonStackAnalysisHelper = [
	'import json,sys,tokenize,types',
	'filename=sys.argv[1]',
	'with tokenize.open(filename) as source_file:',
	'    source=source_file.read()',
	"root=compile(source,filename,'exec')",
	'entries=[]',
	'def walk(code,nesting):',
	'    name=code.co_name',
	"    fallback='.'.join([*nesting,name]) if nesting else name",
	"    qualified=getattr(code,'co_qualname',fallback)",
	"    entries.append({'qualifiedName':qualified,'firstLine':code.co_firstlineno,'stackSize':code.co_stacksize,'nesting':nesting})",
	"    child_nesting=nesting if name=='<module>' else [*nesting,name]",
	'    for constant in code.co_consts:',
	'        if isinstance(constant,types.CodeType):',
	'            walk(constant,child_nesting)',
	'walk(root,[])',
	// ASCII-only JSON is stable even when a Windows interpreter inherits a
	// legacy pipe encoding; JSON parsing restores the original Unicode names.
	"print(json.dumps({'entries':entries},ensure_ascii=True,separators=(',',':')))",
].join('\n');

export const pythonStackAnalysisProducer: ArtifactProducer = async (
	backend,
	source,
	options,
	cancellationToken,
) => {
	const raw = await backend.produceStdoutArtifact(
		'stack-analysis',
		source,
		options,
		{ arguments: () => ['-I', '-c', pythonStackAnalysisHelper] },
		cancellationToken,
	);
	const records = parsePythonStackUsage(raw.text);
	return {
		...raw,
		text: JSON.stringify({ entries: records }),
	};
};

export function parsePythonStackUsage(text: string): readonly PythonStackUsageRecord[] {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		throw new Error('Python stack analysis returned malformed JSON.', {
			cause: error,
		});
	}
	if (!isRecord(value) || !Array.isArray(value.entries)) {
		throw new Error('Python stack analysis JSON does not contain an entries array.');
	}
	return Object.freeze(value.entries.map((entry, index) => {
		if (
			!isRecord(entry)
			|| typeof entry.qualifiedName !== 'string'
			|| !entry.qualifiedName
			|| !isNonNegativeSafeInteger(entry.stackSize)
			|| !isPositiveSafeInteger(entry.firstLine)
			|| !Array.isArray(entry.nesting)
			|| !entry.nesting.every(item => typeof item === 'string')
		) {
			throw new Error(`Python stack analysis entry ${index + 1} is invalid.`);
		}
		return Object.freeze({
			qualifiedName: entry.qualifiedName,
			firstLine: entry.firstLine,
			stackSize: entry.stackSize,
			nesting: Object.freeze([...entry.nesting]),
		});
	}));
}

export function renderPythonStackAnalysis(
	raw: RawArtifact,
	_options: DisplayOptions,
	context: ArtifactRenderContext,
): RenderedTextArtifact {
	const records = parsePythonStackUsage(raw.text);
	const entries: StackUsageEntry[] = records.map(record => ({
		sourceUri: context.source.uri.fsPath,
		sourceLine: record.firstLine,
		sourceColumn: 1,
		functionName: record.qualifiedName,
		value: record.stackSize,
		unit: 'vm-slots',
		qualifier: 'vm',
	}));
	return renderStackUsage(
		raw,
		context,
		entries,
		[],
		['Python values are interpreter evaluation-stack slots, not native frame bytes.'],
		'vm-slots',
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}
