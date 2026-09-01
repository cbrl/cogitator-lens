import type {
	ArtifactFold,
	ArtifactLink,
	ArtifactSymbol,
	DisplayOptions,
	RawArtifact,
	RenderedArtifactLine,
	RenderedTextArtifact,
} from '../../types/index.js';
import { DotNetAsmParser } from '../../vendor/lib/parsers/asm-parser-dotnet.js';
import type { DotNetMethodSourceMapping, DotNetSourceMapping } from '../../vendor/lib/parsers/pdb-parser-dotnet.js';
import type { ArtifactRenderContext } from '../core/artifact-definitions.js';
import { renderedArtifact } from '../core/rendered-artifact.js';

const dotNetParser = new DotNetAsmParser();
const instructionPattern = /^\s*(IL_[0-9a-f]+):\s+(\S+)/i;
const labelPattern = /\bIL_[0-9a-f]+\b/gi;

interface MethodSpan {
	readonly id: number;
	readonly startLine: number;
	readonly endLine: number;
	readonly name: string;
	readonly header: string;
}

export function renderDotNetIl(
	raw: RawArtifact,
	_options: DisplayOptions,
	context: ArtifactRenderContext,
): RenderedTextArtifact {
	// CE routes ILDasm through its .NET assembly parser. Keep that normalization
	// boundary, then layer IL-specific structure and navigation on its output.
	const parsed = dotNetParser.process(raw.text, { labels: false, commentOnly: false });
	const lines: RenderedArtifactLine[] = parsed.asm.map((line) => ({
		text: line.text,
		source: line.source
			? {
					file: line.source.file,
					line: line.source.line,
					column: line.source.column,
					mainSource: line.source.mainsource,
				}
			: line.source,
	}));
	const methods = findMethods(lines);
	applySourceMappings(lines, methods, raw.dotnetSourceMapping, context);
	const scopes = methodScopes(lines.length, methods);
	const definitions = new Map<string, number>();
	let instructionCount = 0;
	let codeSizeBytes = 0;

	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const instruction = instructionPattern.exec(lines[lineIndex].text);
		if (instruction) {
			instructionCount++;
			definitions.set(scopedLabel(scopes[lineIndex], instruction[1]), lineIndex);
		}
		const codeSize = /\/\/\s*Code size\s+(\d+)\b/i.exec(lines[lineIndex].text);
		if (codeSize) {
			codeSizeBytes += Number.parseInt(codeSize[1], 10);
		}
	}

	const links: ArtifactLink[] = [];
	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const text = lines[lineIndex].text;
		const definition = instructionPattern.exec(text);
		const edgeKind = definition ? ilBranchKind(definition[2]) : undefined;
		for (const match of text.matchAll(labelPattern)) {
			if (match.index === undefined || (definition && match.index === text.indexOf(definition[1]))) {
				continue;
			}
			const targetLine = definitions.get(scopedLabel(scopes[lineIndex], match[0]));
			if (targetLine !== undefined) {
				links.push({
					line: lineIndex,
					startCharacter: match.index,
					endCharacter: match.index + match[0].length,
					targetLine,
					...(edgeKind ? { edgeKind } : {}),
				});
			}
		}
	}

	const symbols: ArtifactSymbol[] = methods.map((method) => ({ name: method.name, line: method.startLine }));
	const folds: ArtifactFold[] = methods
		.filter((method) => method.endLine > method.startLine)
		.map((method) => ({ startLine: method.startLine, endLine: method.endLine }));
	return {
		...renderedArtifact(raw, lines, {
			methodCount: methods.length,
			instructionCount,
			labelCount: definitions.size,
			codeSizeBytes,
		}),
		links,
		folds,
		symbols,
	};
}

function ilBranchKind(opcode: string): 'unconditional' | 'true' | undefined {
	const normalized = opcode.toLowerCase();
	if (['br', 'br.s', 'leave', 'leave.s'].includes(normalized)) {
		return 'unconditional';
	}
	return /^(?:br(?:false|true)(?:\.s)?|b(?:eq|ge|gt|le|lt|ne\.un)(?:\.un)?(?:\.s)?|switch)$/u.test(normalized)
		? 'true'
		: undefined;
}

function findMethods(lines: readonly RenderedArtifactLine[]): MethodSpan[] {
	const methods: MethodSpan[] = [];
	let startLine: number | undefined;
	let header = '';
	let braceDepth = 0;
	let bodyStarted = false;

	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const text = lines[lineIndex].text;
		if (startLine === undefined && /^\s*\.method\b/i.test(text)) {
			startLine = lineIndex;
			header = text.trim();
			braceDepth = 0;
			bodyStarted = false;
		} else if (startLine !== undefined && !bodyStarted) {
			header += ` ${text.trim()}`;
		}
		if (startLine === undefined) {
			continue;
		}

		const code = text.replace(/\/\/.*$/u, '');
		const opens = countCharacter(code, '{');
		const closes = countCharacter(code, '}');
		if (opens > 0) {
			bodyStarted = true;
		}
		braceDepth += opens - closes;
		const endComment = /\/\/\s*end of method\s+(.+?)\s*$/i.exec(text);
		if (endComment || (bodyStarted && braceDepth <= 0)) {
			methods.push({
				id: methods.length,
				startLine,
				endLine: lineIndex,
				name: endComment?.[1] ?? methodNameFromHeader(header),
				header,
			});
			startLine = undefined;
			header = '';
			bodyStarted = false;
		}
	}
	if (startLine !== undefined) {
		methods.push({
			id: methods.length,
			startLine,
			endLine: lines.length - 1,
			name: methodNameFromHeader(header),
			header,
		});
	}
	return methods;
}

function applySourceMappings(
	lines: RenderedArtifactLine[],
	methods: readonly MethodSpan[],
	sourceMappings: DotNetSourceMapping | undefined,
	context: ArtifactRenderContext,
): void {
	if (!sourceMappings?.length) {
		return;
	}
	const used = new Set<DotNetMethodSourceMapping>();
	for (const method of methods) {
		const mapping = matchingSourceMapping(method, sourceMappings, used);
		if (!mapping) {
			continue;
		}
		used.add(mapping);
		const offsets = Object.keys(mapping.offsets)
			.map(Number)
			.sort((left, right) => left - right);
		for (let lineIndex = method.startLine; lineIndex <= method.endLine; lineIndex++) {
			const instruction = instructionPattern.exec(lines[lineIndex].text);
			if (!instruction) {
				continue;
			}
			const offset = Number.parseInt(instruction[1].slice(3), 16);
			const sourceOffset = precedingOffset(offsets, offset);
			const source = sourceOffset === undefined ? undefined : mapping.offsets[sourceOffset];
			if (!source || source.line === null || source.line <= 0) {
				continue;
			}
			lines[lineIndex] = {
				...lines[lineIndex],
				source: {
					file: source.file ?? context.source.uri.fsPath,
					line: source.line,
					column: source.column === undefined ? undefined : Math.max(0, source.column - 1),
					mainSource: source.file === null,
				},
			};
		}
	}
}

function precedingOffset(offsets: readonly number[], target: number): number | undefined {
	let result: number | undefined;
	for (const offset of offsets) {
		if (offset > target) {
			break;
		}
		result = offset;
	}
	return result;
}

function matchingSourceMapping(
	method: MethodSpan,
	sourceMappings: DotNetSourceMapping,
	used: ReadonlySet<DotNetMethodSourceMapping>,
): DotNetMethodSourceMapping | undefined {
	const separator = method.name.lastIndexOf('::');
	const typeName = separator === -1 ? '' : normalizeTypeName(method.name.slice(0, separator));
	const methodName = separator === -1 ? methodNameFromHeader(method.header) : method.name.slice(separator + 2);
	const candidates = sourceMappings.filter(
		(mapping) =>
			!used.has(mapping) &&
			mapping.method.methodName === methodName &&
			(!typeName || normalizeTypeName(mapping.method.typeName).endsWith(typeName)),
	);
	return (
		candidates[0] ??
		sourceMappings.find((mapping) => !used.has(mapping) && mapping.method.methodName === methodName)
	);
}

function normalizeTypeName(name: string): string {
	return name.replaceAll('/', '+').replace(/^.*?\./u, '');
}

function methodNameFromHeader(header: string): string {
	const beforeParameters = header.slice(0, header.indexOf('(') === -1 ? undefined : header.indexOf('(')).trim();
	const candidate = beforeParameters.split(/\s+/u).at(-1) ?? '<method>';
	return candidate.replace(/^'(.*)'$/u, '$1');
}

function methodScopes(lineCount: number, methods: readonly MethodSpan[]): number[] {
	const scopes = new Array<number>(lineCount).fill(-1);
	for (const method of methods) {
		for (let line = method.startLine; line <= method.endLine; line++) {
			scopes[line] = method.id;
		}
	}
	return scopes;
}

function scopedLabel(scope: number, label: string): string {
	return `${scope}:${label.toUpperCase()}`;
}

function countCharacter(text: string, character: string): number {
	let count = 0;
	for (const candidate of text) {
		if (candidate === character) {
			count++;
		}
	}
	return count;
}
