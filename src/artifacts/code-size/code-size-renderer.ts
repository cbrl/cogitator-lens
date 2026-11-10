import path from 'path';
import { isRecord } from '../../common.js';
import type {
	ArtifactSymbol,
	DisplayOptions,
	RawArtifact,
	RenderedArtifactLine,
	RenderedArtifactLineSource,
	RenderedTextArtifact,
} from '../../types/index.js';
import { parsedLine, withLabelNavigation } from '../assembly/assembly-navigation.js';
import type { ArtifactRenderContext } from '../core/artifact-contracts.js';
import { functionRanges } from '../core/artifact-views.js';
import { renderedArtifact } from '../core/rendered-artifact.js';
import { imageSections, type ObjectSection } from './object-sections.js';

/** The size of one function: the bytes of its instructions, and its first source line. */
interface FunctionSize {
	readonly name: string;
	readonly size: number;
	readonly source?: RenderedArtifactLineSource;
}

function sectionsOf(data: unknown): readonly ObjectSection[] | undefined {
	if (!isRecord(data) || !Array.isArray(data.sections)) {
		return undefined;
	}
	return data.sections.flatMap((section: unknown) =>
		isRecord(section) && typeof section.name === 'string' && typeof section.size === 'number'
			? [{ name: section.name, size: section.size }]
			: [],
	);
}

/**
 * The bytes of the opcodes of one instruction. x86 disassembly gives each byte on its own. The GNU
 * objdump of a fixed-width instruction set gives words, such as `d10043ff` on AArch64, and Thumb
 * gives halfwords, such as `f852 3b04`. Two hex digits are one byte in each form.
 */
function opcodeBytes(opcodes: readonly string[] | undefined): number {
	return (opcodes ?? []).reduce((total, opcode) => total + Math.ceil(opcode.length / 2), 0);
}

/**
 * Lists the size of each function and each section of the object file. The size of a function is
 * the sum of the bytes of its instructions in the disassembly, so it has no alignment padding. The
 * largest function comes first. Each function row maps to the first source line of the function,
 * so a click shows it in the source.
 */
export function renderCodeSize(
	raw: RawArtifact,
	options: DisplayOptions,
	context: ArtifactRenderContext,
): RenderedTextArtifact {
	const parsed = context.backend.parseBinaryDisassembly(raw.text, options, {
		path: context.source.uri.fsPath,
		workingDirectory: raw.command.cwd,
	});
	const listing = withLabelNavigation(renderedArtifact(raw, parsed.asm.map(parsedLine)), parsed, (instruction) =>
		context.backend.classifyAssemblyInstruction(instruction),
	);
	const functions: FunctionSize[] = functionRanges(listing)
		.map((range) => {
			const lines = listing.lines.slice(range.startLine, range.endLine + 1);
			const source = lines.find((line) => line.source?.file && line.source.line)?.source ?? undefined;
			return {
				name: range.name,
				size: lines.reduce((total, line) => total + opcodeBytes(line.opcodes), 0),
				...(source ? { source: { file: source.file, line: source.line } } : {}),
			};
		})
		.filter((entry) => entry.size > 0)
		.sort((left, right) => right.size - left.size || left.name.localeCompare(right.name));
	const sections = sectionsOf(raw.producerData);
	const image = sections ? imageSections(sections) : [];
	const total = functions.reduce((sum, entry) => sum + entry.size, 0);
	const sizeWidth = Math.max(5, ...[...functions, ...image].map((entry) => String(entry.size).length));

	const lines: RenderedArtifactLine[] = [
		{
			text: `; Code size of ${path.basename(context.source.uri.fsPath)}: ${functions.length} ${
				functions.length === 1 ? 'function' : 'functions'
			}, ${total} bytes of instructions.`,
		},
		{ text: '; Select a function to show its first source line.' },
		{ text: '' },
		{ text: `; ${'Bytes'.padStart(sizeWidth)}   Share  Function` },
	];
	const symbols: ArtifactSymbol[] = [];
	for (const entry of functions) {
		const share = total > 0 ? `${((entry.size / total) * 100).toFixed(1)}%` : '';
		symbols.push({ name: entry.name, line: lines.length });
		lines.push({
			text: `  ${String(entry.size).padStart(sizeWidth)}  ${share.padStart(6)}  ${entry.name}`,
			...(entry.source ? { source: entry.source } : {}),
		});
	}
	if (image.length > 0) {
		lines.push({ text: '' }, { text: `; ${'Bytes'.padStart(sizeWidth)}  Section` });
		for (const section of image) {
			lines.push({ text: `  ${String(section.size).padStart(sizeWidth)}  ${section.name}` });
		}
	}
	return {
		...renderedArtifact(raw, lines, {
			functionCount: functions.length,
			codeSizeBytes: total,
			...(image.length > 0 ? { sectionBytes: image.reduce((sum, section) => sum + section.size, 0) } : {}),
		}),
		symbols,
	};
}
