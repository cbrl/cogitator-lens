import fs from 'fs';
import os from 'os';
import path from 'path';
import { AsmParser } from './parsers/asm-parser.js';
import * as exec from './exec';
import * as Path from 'path';
import { ParseFiltersAndOutputOptions } from './parsers/filters.interfaces.js';
import { ParsedAsmResult } from './parsers/asmresult.interfaces.js';
import { Uri } from 'vscode';

export type CompilerInfo = {
	name: string;
	type: string;
	exe: string;

	args?: string[];

	includeFlag: string;
	includePaths?: string[];

	defineFlag: string;
	defines?: string[];

	envVars?: Record<string, string>;

	supportsDemangle?: boolean;
	demangler?: string;

	supportsIntel?: boolean;
	supportsLibraryCodeFilter?: boolean;
}

export type CompileOptions = {
	args?: string[];
	defines?: string[];
	includes?: string[];
	env?: Record<string, string>;
}

export interface ICompiler {
	info: CompilerInfo;
	asmParser: AsmParser;

	compile(file: string, options: CompileOptions, filter: ParseFiltersAndOutputOptions): Promise<ParsedAsmResult>;
}

export abstract class CompilerBase implements ICompiler {
	info: CompilerInfo;
	asmParser: AsmParser;
	defaultFilter: ParseFiltersAndOutputOptions = {};

	constructor(info: CompilerInfo) {
		this.info = info;
		this.asmParser = new AsmParser();
	}

	async compile(file: string, options: CompileOptions, filter: ParseFiltersAndOutputOptions): Promise<ParsedAsmResult> {
		const outputDir = os.tmpdir();
		const outputFile = path.join(outputDir, path.basename(replaceExtension(file, '.asm')));

		const args = [
			...(this.info.args ?? []),
			...(options.args ?? []),
			...(this.info.includePaths?.map(value => this.info.includeFlag + value) ?? []),
			...(options.includes?.map(value => this.info.includeFlag + value) ?? []),
			...(this.info.defines?.map(value => this.info.defineFlag + value) ?? []),
			...(options.defines?.map(value => this.info.defineFlag + value) ?? []),
			...this.prepareArgs(outputFile),
			file
		];

		const envVars = Object.assign({}, this.info.envVars ?? {}, options.env ?? {});

		const execResult = await exec.execute(this.info.exe, args, envVars);

		if (execResult.returnCode !== 0) {
			throw new Error(`Failed to compile ${file}: ${execResult.stdout}`);
		}

		// TODO: demangle

		const asmBytes = await fs.promises.readFile(outputFile);
		const asmText = new TextDecoder().decode(asmBytes);

		// Override default settings with user settings (if specified)
		const finalFilter = Object.assign({}, this.defaultFilter, filter);

		return this.asmParser.process(asmText, finalFilter);
	}

	protected abstract prepareArgs(outputFile: string): string[];
}


export function baseCompilerInfoFor(compiler: Uri): CompilerInfo {
	const baseNameWithoutExtension = path.basename(compiler.fsPath, path.extname(compiler.fsPath));

	let defaultInfo = {
		name: baseNameWithoutExtension,
		type: 'gcc',
		exe: compiler.fsPath,
		includeFlag: '-I',
		defineFlag: '-D'
	};

	switch (baseNameWithoutExtension.toLowerCase()) {
		case 'clang-cl': return Object.assign(defaultInfo, {
			type: 'clang-cl',
			includeFlag: '/I',
			defineFlag: '/D'
		});

		case 'cl': return Object.assign(defaultInfo, {
			type: 'msvc',
			includeFlag: '/I',
			defineFlag: '/D'
		});

		default: return defaultInfo;
	}
}

function replaceExtension(filename: string, extension: string): string {
	return Path.join(
		Path.dirname(filename),
		Path.basename(filename, Path.extname(filename)) + extension
	);
}
