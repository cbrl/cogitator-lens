// Copyright (c) 2025, Compiler Explorer Authors
// All rights reserved.
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the conditions in the Compiler
// Explorer BSD 2-Clause license are met. See THIRD_PARTY_NOTICES.md.

import type {
	AsmResultSource,
	ParsedAsmResult,
	ParsedAsmResultLine,
} from '../../types/asmresult/asmresult.interfaces.js';
import type { ParseFiltersAndOutputOptions } from '../../types/features/filters.interfaces.js';
import type { PropertyGetter } from '../properties.interfaces.js';
import * as utils from '../utils.js';
import { AsmParser } from './asm-parser.js';

/** Compiler Explorer's PTX assembly parser, isolated from its compiler server. */
export class PTXAsmParser extends AsmParser {
	private readonly commentOnlyLine = /^\s*\/\//u;
	private readonly emptyLine = /^\s*$/u;
	private readonly externFuncDirective = /^\s*\.extern\s+\.func/u;
	private readonly paramDirective = /^\s*\.param/u;
	private readonly visibleDirective = /^\s*\.visible/u;
	private readonly externFuncStart = /^\s*\.extern\s+\.func/u;
	private readonly openParen = /^\s*\(\s*$/u;
	private readonly closeParen = /^\s*\)\s*$/u;
	private readonly semicolon = /^\s*;\s*$/u;
	private readonly ptxDataDeclaration =
		/^\s*\.global\s+\.align\s+\d+\s+\.(?:b8|b16|b32|b64|u8|u16|u32|u64|s8|s16|s32|s64|f16|f32|f64)/u;
	private readonly functionStart = /^\s*\{/u;
	private readonly functionEnd = /^\s*\}/u;
	private readonly callInstruction = /^\s*call\./u;
	private readonly functionCallEnd = /^\s*\)\s*;\s*$/u;
	private readonly labelLine = /^\s*\$?[a-zA-Z_][a-zA-Z0-9_]*:.*$/u;

	constructor(compilerProps?: PropertyGetter) {
		super(compilerProps);
		this.directive = /^\s*\..*$/u;
		this.fileFind = /^\s*\.file\s+(\d+)\s+"([^"]+)"/u;
		this.sourceTag = /^\s*\.loc\s+(\d+)\s+(\d+)\s+(\d+)/u;
		this.hasOpcodeRe = /^\s*\{?\s*(@!?%\w+\s+)?(%[$.A-Z_a-z][\w$.]*\s*=\s*)?[A-Za-z]/u;
	}

	override processAsm(asmResult: string, filters: ParseFiltersAndOutputOptions): ParsedAsmResult {
		const startTime = process.hrtime.bigint();
		const asm: ParsedAsmResultLine[] = [];
		const asmLines = utils.splitLines(asmResult);
		const startingLineCount = asmLines.length;
		const files = this.parseFiles(asmLines);
		let currentSource: AsmResultSource | null = null;
		let inExternFuncDeclaration = false;
		let externFuncSeenCloseParen = false;
		let inFunctionImplementation = false;
		let functionBraceDepth = 0;
		let inFunctionCall = false;
		let callBaseIndent = '';
		let braceDepth = 0;
		let lineNumber = 0;
		let openBraceLineNumber = 0;
		let openBraceLineHasOpcode = false;

		for (let line of asmLines) {
			const newSource = this.processSourceLine(line, files);
			if (newSource) currentSource = newSource;
			if (this.externFuncStart.test(line)) {
				inExternFuncDeclaration = true;
				externFuncSeenCloseParen = false;
			} else if (inExternFuncDeclaration && this.closeParen.test(line)) {
				externFuncSeenCloseParen = true;
			}
			if (this.functionStart.test(line)) {
				functionBraceDepth++;
				if (functionBraceDepth === 1) inFunctionImplementation = true;
			} else if (this.functionEnd.test(line)) {
				functionBraceDepth--;
				if (functionBraceDepth === 0) inFunctionImplementation = false;
			}
			if (this.callInstruction.test(line)) {
				inFunctionCall = true;
				callBaseIndent = `${line.match(/^(\s*)/u)?.[1] ?? ''}\t`;
			} else if (inFunctionCall && this.functionCallEnd.test(line)) {
				inFunctionCall = false;
				callBaseIndent = '';
			}
			if (filters.libraryCode && inExternFuncDeclaration) {
				if (externFuncSeenCloseParen && this.semicolon.test(line)) {
					inExternFuncDeclaration = false;
					externFuncSeenCloseParen = false;
				}
				continue;
			}
			if (filters.commentOnly) {
				if (this.commentOnlyLine.test(line) || this.emptyLine.test(line)) continue;
				const commentIndex = line.indexOf('//');
				if (commentIndex > 0) line = line.substring(0, commentIndex).trimEnd();
			}
			if (filters.directives && this.shouldSkipPTXDirective(line, inFunctionImplementation)) continue;

			let processedLine = line;
			if (this.labelLine.test(line)) {
				processedLine = line.trim();
			} else {
				let indentLevel = braceDepth;
				if (this.functionEnd.test(line)) indentLevel = Math.max(0, braceDepth - 1);
				if (indentLevel > 0) {
					processedLine = `${'\t'.repeat(indentLevel)}${line.trim()}`;
				} else if (inFunctionCall && !this.functionCallEnd.test(line)) {
					processedLine = this.improveCallIndentation(line, callBaseIndent);
				}
			}
			if (this.functionStart.test(line)) {
				braceDepth++;
				openBraceLineNumber = lineNumber;
				openBraceLineHasOpcode = this.hasOpcode(line);
			} else if (this.functionEnd.test(line)) {
				braceDepth--;
				if (openBraceLineNumber + 1 === lineNumber && !openBraceLineHasOpcode) {
					asm.pop();
					continue;
				}
			}
			if (filters.trim) processedLine = this.applyTrimFilter(processedLine);
			asm.push({
				text: processedLine,
				source: this.hasOpcode(line) ? currentSource : null,
				labels: [],
			});
			lineNumber++;
		}
		return {
			asm,
			labelDefinitions: {},
			languageId: 'ptx',
			parsingTime: utils.deltaTimeNanoToMili(startTime, process.hrtime.bigint()),
			filteredCount: startingLineCount - asm.length,
		};
	}

	private shouldSkipPTXDirective(line: string, inFunctionImplementation: boolean): boolean {
		if (!this.directive.test(line)) return false;
		if (this.externFuncDirective.test(line)) return false;
		if (this.paramDirective.test(line)) return inFunctionImplementation;
		if (this.visibleDirective.test(line)) return false;
		if (this.ptxDataDeclaration.test(line)) return false;
		return true;
	}

	private processSourceLine(line: string, files: Record<number, string>): AsmResultSource | null {
		const match = line.match(this.sourceTag);
		if (!match) return null;
		const file = files[Number.parseInt(match[1], 10)];
		return file ? {
			file: utils.maskRootdir(file),
			line: Number.parseInt(match[2], 10),
			column: Number.parseInt(match[3], 10),
			mainsource: true,
		} : null;
	}

	private improveCallIndentation(line: string, baseIndent: string): string {
		const trimmed = line.trim();
		if (!trimmed) return line;
		const currentIndent = line.match(/^(\s*)/u)?.[1] ?? '';
		if (/^[a-zA-Z_][a-zA-Z0-9_]*,?\s*$/u.test(trimmed) || this.openParen.test(trimmed)) {
			return currentIndent + baseIndent.slice(currentIndent.length) + trimmed;
		}
		if (trimmed === ')' || trimmed === ');') {
			const adjustedIndent = baseIndent.slice(0, -1);
			return currentIndent + adjustedIndent.slice(currentIndent.length) + trimmed;
		}
		return line;
	}

	private applyTrimFilter(line: string): string {
		if (line.trim().length === 0) return '';
		const leadingTabs = line.match(/^(\t*)/u)?.[1].length ?? 0;
		const content = line.substring(leadingTabs).replace(/\t/gu, ' ')
			.split(/(\s+)/u)
			.map((part, index) => index > 0 && /^\s+$/u.test(part) ? ' ' : part)
			.join('');
		return `${'  '.repeat(leadingTabs)}${content}`;
	}
}
