import path from 'node:path';
import type {
	ArtifactFold,
	ArtifactLink,
	ArtifactSymbol,
	DisplayOptions,
	RawArtifact,
	RenderedArtifactLine,
	RenderedTextArtifact,
} from '../../types/index.js';
import { splitLines } from '../../common.js';
import type { ArtifactRenderContext } from '../core/artifact-contracts.js';
import { renderedArtifact } from '../core/rendered-artifact.js';
import { javaBytecodeInstruction } from './java-bytecode-listing.js';

/** A javap listing with the structure and the source lines of its methods. */
export interface JavaBytecodeListing {
	readonly lines: readonly RenderedArtifactLine[];
	readonly links: readonly ArtifactLink[];
	readonly folds: readonly ArtifactFold[];
	readonly symbols: readonly ArtifactSymbol[];
	readonly instructionCount: number;
	readonly sourceLineCount: number;
}

/** The first line of a class in `javap -c` output, such as `public class com.example.Shapes {`. */
const classDeclaration = /^(?:[\w-]+\s+)*?(?:class|interface|enum|module)\s+([^\s<{]+)[^{]*\{\s*$/u;
const compiledFrom = /^Compiled from "(.*)"\s*$/u;
/** A member of a class: a field or the signature of a method. javap indents it by two spaces. */
const memberLine = /^ {2}\S/u;
const codeHeader = /^\s+Code:\s*$/u;
const lineNumberTableHeader = /^\s+LineNumberTable:\s*$/u;
const lineNumberEntry = /^\s+line (\d+): (\d+)\s*$/u;
/**
 * The header of another attribute of a method, such as `Exception table:` or `LocalVariableTable:`.
 * javap 21 indents it by four spaces, and javap 27 by six, under `Code:`.
 */
const attributeHeader = /^\s{4,}[A-Z][\w ]*:/u;
const exceptionTableRow = /^\s+(\d+)\s+(\d+)\s+(\d+)\s+\S/u;
const switchCase = /^\s+(-?\d+|default): (-?\d+)\s*$/u;
const switchEnd = /^\s+\}\s*$/u;
const branchTarget = /\s(-?\d+)\s*$/u;
/** A method reference in the comment of an invoke instruction, with or without its class. */
const methodReference = /\/\/ (?:Interface)?Method (?:([^\s."]+)\.)?("[^"]+"|[^\s.:"]+):(\(\S*)/u;

const conditionalBranches = new Set([
	'ifeq',
	'ifne',
	'iflt',
	'ifge',
	'ifgt',
	'ifle',
	'if_icmpeq',
	'if_icmpne',
	'if_icmplt',
	'if_icmpge',
	'if_icmpgt',
	'if_icmple',
	'if_acmpeq',
	'if_acmpne',
	'ifnull',
	'ifnonnull',
]);
const unconditionalBranches = new Set(['goto', 'goto_w']);
/** Old class files call a subroutine with these. The target is in the same method. */
const subroutineCalls = new Set(['jsr', 'jsr_w']);

interface Instruction {
	readonly line: number;
	readonly offset: number;
	readonly mnemonic: string;
}

interface MethodCode {
	readonly className: string;
	readonly signatureLine: number;
	readonly instructions: Instruction[];
	/** Lines of a switch body, each with the line of its switch instruction. */
	readonly switchLines: Map<number, number>;
	readonly lineTable: { readonly sourceLine: number; readonly offset: number }[];
	readonly exceptionRows: number[];
}

interface MethodSymbol {
	readonly line: number;
	readonly className: string;
	readonly name: string;
	readonly parameters: string;
}

/**
 * Reads the output of `javap -c -l -p` for the class files of one source. The `Code:` headers and
 * the line number tables are not shown: each instruction connects to its source line instead. The
 * classes of other sources, which a `Compiled from` line names, connect to no source line.
 */
export function parseJavapListing(output: string, sourcePath: string): JavaBytecodeListing {
	const lines: RenderedArtifactLine[] = [];
	const folds: ArtifactFold[] = [];
	const methods: MethodCode[] = [];
	const symbols: MethodSymbol[] = [];
	const mainSource = new Map<MethodCode, boolean>();
	let className: string | undefined;
	let classStart = 0;
	let fromSource = true;
	let member: { line: number; text: string } | undefined;
	let method: MethodCode | undefined;
	let section: 'code' | 'switch' | 'line-numbers' | 'exceptions' | 'other' = 'other';
	let switchInstruction = -1;

	const endMethod = (): void => {
		if (method) {
			let end = lines.length - 1;
			while (end > method.signatureLine && !lines[end].text.trim()) {
				end--;
			}
			if (end > method.signatureLine) {
				folds.push({ startLine: method.signatureLine, endLine: end });
			}
		}
		method = undefined;
		section = 'other';
	};

	// On Windows, javap 27 ends the lines of a switch body with `\r\r\n`.
	for (const text of splitLines(output.replace(/\r+\n/gu, '\n'))) {
		const from = compiledFrom.exec(text);
		if (from && className === undefined) {
			fromSource = sameFileName(from[1], path.basename(sourcePath));
			continue;
		}
		if (className === undefined) {
			const declaration = classDeclaration.exec(text);
			if (declaration) {
				if (lines.length > 0 && lines.at(-1)?.text.trim()) {
					lines.push({ text: '' });
				}
				className = declaration[1];
				classStart = lines.length;
			}
			lines.push({ text });
			continue;
		}
		if (text === '}') {
			endMethod();
			lines.push({ text });
			folds.push({ startLine: classStart, endLine: lines.length - 1 });
			className = undefined;
			fromSource = true;
			member = undefined;
			continue;
		}
		if (memberLine.test(text)) {
			endMethod();
			member = { line: lines.length, text: text.trim() };
			lines.push({ text });
			continue;
		}
		if (codeHeader.test(text) && member) {
			endMethod();
			method = {
				className,
				signatureLine: member.line,
				instructions: [],
				switchLines: new Map(),
				lineTable: [],
				exceptionRows: [],
			};
			methods.push(method);
			mainSource.set(method, fromSource);
			const signature = methodSignature(member.text, className);
			if (signature) {
				symbols.push({ line: member.line, className, ...signature });
			}
			section = 'code';
			continue;
		}
		if (!method) {
			lines.push({ text });
			continue;
		}
		if (section === 'switch') {
			method.switchLines.set(lines.length, switchInstruction);
			if (switchEnd.test(text)) {
				section = 'code';
			}
			lines.push({ text });
			continue;
		}
		if (lineNumberTableHeader.test(text)) {
			section = 'line-numbers';
			continue;
		}
		if (section === 'line-numbers') {
			const entry = lineNumberEntry.exec(text);
			if (entry) {
				method.lineTable.push({ sourceLine: Number(entry[1]), offset: Number(entry[2]) });
				continue;
			}
		}
		if (attributeHeader.test(text)) {
			section = /^\s+Exception table:/u.test(text) ? 'exceptions' : 'other';
			lines.push({ text });
			continue;
		}
		const instruction = section === 'code' ? javaBytecodeInstruction.exec(text) : null;
		if (instruction) {
			method.instructions.push({ line: lines.length, offset: Number(instruction[1]), mnemonic: instruction[2] });
			if (instruction[2] === 'tableswitch' || instruction[2] === 'lookupswitch') {
				section = 'switch';
				switchInstruction = lines.length;
			}
		} else if (section === 'exceptions' && exceptionTableRow.test(text)) {
			method.exceptionRows.push(lines.length);
		}
		lines.push({ text });
	}
	endMethod();

	const links: ArtifactLink[] = [];
	const mappedSourceLines = new Set<number>();
	const methodLines = methodLookup(symbols);
	for (const code of methods) {
		const instructionLines = new Map(
			code.instructions.map((instruction) => [instruction.offset, instruction.line]),
		);
		const sourceLines = new Map<number, number>();
		for (const instruction of code.instructions) {
			const sourceLine = sourceLineAt(code.lineTable, instruction.offset);
			if (sourceLine !== undefined) {
				sourceLines.set(instruction.line, sourceLine);
			}
			links.push(...branchLinks(lines[instruction.line].text, instruction, instructionLines));
			const call = callLink(lines[instruction.line].text, instruction.line, code.className, methodLines);
			if (call) {
				links.push(call);
			}
		}
		for (const [line, switchLine] of code.switchLines) {
			const sourceLine = sourceLines.get(switchLine);
			if (sourceLine !== undefined) {
				sourceLines.set(line, sourceLine);
			}
			const target = switchCase.exec(lines[line].text);
			const targetLine = target ? instructionLines.get(Number(target[2])) : undefined;
			if (target && targetLine !== undefined) {
				const start = lines[line].text.lastIndexOf(target[2]);
				links.push({
					line,
					startCharacter: start,
					endCharacter: start + target[2].length,
					targetLine,
					edgeKind: 'true',
				});
			}
		}
		for (const line of code.exceptionRows) {
			links.push(...offsetLinks(lines[line].text, line, instructionLines));
		}
		if (!mainSource.get(code)) {
			continue;
		}
		for (const [line, sourceLine] of sourceLines) {
			mappedSourceLines.add(sourceLine);
			lines[line] = { ...lines[line], source: { file: sourcePath, line: sourceLine, mainSource: true } };
		}
	}

	return {
		lines,
		links,
		folds,
		symbols: symbols.map((symbol) => ({
			name: `${symbol.className}.${symbol.name}(${symbol.parameters})`,
			line: symbol.line,
		})),
		instructionCount: methods.reduce((total, code) => total + code.instructions.length, 0),
		sourceLineCount: mappedSourceLines.size,
	};
}

export function renderJavaBytecode(
	raw: RawArtifact,
	_options: DisplayOptions,
	context: ArtifactRenderContext,
): RenderedTextArtifact {
	const listing = parseJavapListing(raw.text, context.source.uri.fsPath);
	return {
		...renderedArtifact(raw, listing.lines, {
			methodCount: listing.symbols.length,
			instructionCount: listing.instructionCount,
			sourceLineCount: listing.sourceLineCount,
		}),
		links: listing.links,
		folds: listing.folds,
		symbols: listing.symbols,
	};
}

/**
 * The source line of an instruction. The entry with the greatest start offset at or before the
 * instruction applies. The table can list its entries in any order.
 */
function sourceLineAt(
	table: readonly { readonly sourceLine: number; readonly offset: number }[],
	offset: number,
): number | undefined {
	let best: { readonly sourceLine: number; readonly offset: number } | undefined;
	for (const entry of table) {
		if (entry.offset <= offset && (!best || entry.offset >= best.offset)) {
			best = entry;
		}
	}
	return best?.sourceLine;
}

function branchLinks(
	text: string,
	instruction: Instruction,
	instructionLines: ReadonlyMap<number, number>,
): ArtifactLink[] {
	const conditional = conditionalBranches.has(instruction.mnemonic);
	const unconditional = unconditionalBranches.has(instruction.mnemonic);
	if (!conditional && !unconditional && !subroutineCalls.has(instruction.mnemonic)) {
		return [];
	}
	const target = branchTarget.exec(text);
	const targetLine = target ? instructionLines.get(Number(target[1])) : undefined;
	if (!target || targetLine === undefined) {
		return [];
	}
	const start = text.lastIndexOf(target[1]);
	return [
		{
			line: instruction.line,
			startCharacter: start,
			endCharacter: start + target[1].length,
			targetLine,
			...(conditional
				? { edgeKind: 'true' as const }
				: unconditional
					? { edgeKind: 'unconditional' as const }
					: {}),
		},
	];
}

/** Links the start, end, and handler offsets of an exception table row to their instructions. */
function offsetLinks(text: string, line: number, instructionLines: ReadonlyMap<number, number>): ArtifactLink[] {
	const links: ArtifactLink[] = [];
	for (const match of [...text.matchAll(/\d+/gu)].slice(0, 3)) {
		const targetLine = instructionLines.get(Number(match[0]));
		if (match.index !== undefined && targetLine !== undefined) {
			links.push({ line, startCharacter: match.index, endCharacter: match.index + match[0].length, targetLine });
		}
	}
	return links;
}

/** The name and the parameters of a method signature, or nothing for a field. */
function methodSignature(
	signature: string,
	className: string,
): { readonly name: string; readonly parameters: string } | undefined {
	if (/^static\s*\{\s*\}\s*;$/u.test(signature)) {
		return { name: '<clinit>', parameters: '' };
	}
	const open = signature.indexOf('(');
	const close = signature.lastIndexOf(')');
	if (open < 0 || close < open) {
		return undefined;
	}
	const name = withoutTypeArguments(signature.slice(0, open)).trim().split(/\s+/u).at(-1) ?? '';
	return {
		name: name === className ? '<init>' : name,
		parameters: signature.slice(open + 1, close).trim(),
	};
}

/** The methods of the listing by class, name, and erased parameter types. */
function methodLookup(symbols: readonly MethodSymbol[]): {
	readonly exact: ReadonlyMap<string, number>;
	readonly byName: ReadonlyMap<string, readonly number[]>;
} {
	const exact = new Map<string, number>();
	const byName = new Map<string, number[]>();
	for (const symbol of symbols) {
		exact.set(`${symbol.className}.${symbol.name}(${erasedParameters(symbol.parameters)})`, symbol.line);
		const key = `${symbol.className}.${symbol.name}`;
		byName.set(key, [...(byName.get(key) ?? []), symbol.line]);
	}
	return { exact, byName };
}

/**
 * Links the method of an invoke instruction to the method in the listing. javap leaves out the class
 * of a method in the same class. It also leaves out some parameters of a constructor, such as the
 * outer instance, so a name with one method in the listing matches without its parameters.
 */
function callLink(
	text: string,
	line: number,
	className: string,
	methods: ReturnType<typeof methodLookup>,
): ArtifactLink | undefined {
	if (!/^\s*\d+: invoke/u.test(text)) {
		return undefined;
	}
	const reference = methodReference.exec(text);
	if (!reference || reference.index === undefined) {
		return undefined;
	}
	const owner = reference[1] ? reference[1].replaceAll('/', '.') : className;
	const name = reference[2].replace(/^"(.*)"$/u, '$1');
	const parameters = descriptorParameters(reference[3]);
	const candidates = methods.byName.get(`${owner}.${name}`) ?? [];
	const targetLine =
		(parameters === undefined ? undefined : methods.exact.get(`${owner}.${name}(${parameters})`)) ??
		(candidates.length === 1 ? candidates[0] : undefined);
	if (targetLine === undefined) {
		return undefined;
	}
	// The link covers the class and the name, such as `com/example/Helper.twice`.
	const start = reference.index + reference[0].indexOf(reference[1] ?? reference[2]);
	const end = reference.index + reference[0].indexOf(`${reference[2]}:`) + reference[2].length;
	return { line, startCharacter: start, endCharacter: end, targetLine };
}

/** The parameter types of a method descriptor, such as `(I[Ljava/lang/String;)V`, as javap writes them. */
export function descriptorParameters(descriptor: string): string | undefined {
	const close = descriptor.indexOf(')');
	if (!descriptor.startsWith('(') || close < 0) {
		return undefined;
	}
	const primitives: Readonly<Record<string, string>> = {
		B: 'byte',
		C: 'char',
		D: 'double',
		F: 'float',
		I: 'int',
		J: 'long',
		S: 'short',
		Z: 'boolean',
	};
	const types: string[] = [];
	let dimensions = 0;
	for (let index = 1; index < close; index++) {
		const character = descriptor[index];
		if (character === '[') {
			dimensions++;
			continue;
		}
		let type = primitives[character];
		if (character === 'L') {
			const end = descriptor.indexOf(';', index);
			if (end < 0) {
				return undefined;
			}
			type = descriptor.slice(index + 1, end).replaceAll('/', '.');
			index = end;
		}
		if (type === undefined) {
			return undefined;
		}
		types.push(type + '[]'.repeat(dimensions));
		dimensions = 0;
	}
	return types.join(',');
}

/** The parameter types of a javap signature without type arguments and spaces, as a descriptor has them. */
function erasedParameters(parameters: string): string {
	return withoutTypeArguments(parameters)
		.split(',')
		.map((parameter) => parameter.trim().replace(/\.\.\.$/u, '[]'))
		.filter((parameter) => parameter)
		.join(',');
}

function withoutTypeArguments(text: string): string {
	let result = text;
	for (let previous = ''; previous !== result;) {
		previous = result;
		result = result.replace(/<[^<>]*>/gu, '');
	}
	return result;
}

function sameFileName(left: string, right: string): boolean {
	return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}
