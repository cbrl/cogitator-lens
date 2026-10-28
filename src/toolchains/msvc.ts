import fs from 'fs';
import path from 'path';
import type { CancellationToken } from 'vscode';
import { localFileComparisonKey } from '../file-identity.js';
import { VcAsmParser } from '../vendor/lib/parsers/asm-parser-vc.js';
import { noopPropertyGetter } from '../vendor/compiler-props.js';
import type { ParsedAsmResult } from '../vendor/types/asmresult/asmresult.interfaces.js';
import type { ParseFiltersAndOutputOptions } from '../vendor/types/features/filters.interfaces.js';
import type { ToolchainProfile } from '../types/index.js';
import * as exec from '../exec.js';
import { ExecError } from '../exec.js';
import { outputProducer } from '../artifacts/core/compiler-output-producer.js';
import type { BinaryDisassembler } from '../artifacts/binary-disassembly/binary-disassembly-producer.js';
import { masmProcedureLine } from '../artifacts/assembly/assembly-navigation.js';
import { parseMsvcSourceDependencies } from '../compilation/artifact-inputs.js';
import { MsvcAssemblyCfgParser } from '../artifacts/control-flow-graph/parsers/assembly-dialects.js';
import {
	compilerAssembly,
	assemblyControlFlowGraphOutput,
	binaryDisassembly,
	toolDiscoverer,
	withoutOwnedArguments,
	type OwnedArguments,
	type ToolchainDefinition,
} from './toolchain-contracts.js';
import { readBoundedArtifactBuffer, type DependencyCollectionSpec } from './toolchain-backend.js';
import { cFamilyLanguageIdentifiers } from './c-family.js';
import { parseParenthesizedDiagnostics } from './msvc/diagnostics.js';
import { readCodeViewLines, withCodeViewSourceLines, type CodeViewLineTable } from './msvc/codeview-lines.js';

export const visualStudioDiscoveryArguments = [
	'-latest',
	'-prerelease',
	'-products',
	'*',
	'-requires',
	'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
	'-property',
	'installationPath',
] as const;

/**
 * Returns the vcvarsall.bat argument that selects the toolset of a compiler in
 * `VC\Tools\MSVC\<version>`. Without it, vcvarsall.bat selects the default toolset, and the
 * headers of that toolset reject an older compiler.
 */
export function visualStudioToolsetArgument(executable: string): string | undefined {
	const version = /[\\/]VC[\\/]Tools[\\/]MSVC[\\/](\d+\.\d+\.\d+)[\\/]/i.exec(executable)?.[1];
	return version && `-vcvars_ver=${version}`;
}

/** Returns vcvarsall.bat locations implied by a compiler path within a Visual Studio install. */
export function visualStudioEnvironmentCandidates(executable: string): readonly string[] {
	const candidates: string[] = [];
	let directory = path.win32.dirname(executable);
	while (true) {
		if (path.win32.basename(directory).toLowerCase() === 'vc') {
			candidates.push(path.win32.join(directory, 'Auxiliary', 'Build', 'vcvarsall.bat'));
		}
		const parent = path.win32.dirname(directory);
		if (parent === directory) {
			return candidates;
		}
		directory = parent;
	}
}

/** The source comment of a `/FAcs` listing, `; 12   : text`, which gives the line of the code after it. */
const msvcSourceComment = /^; (\d+)[ \t]*:/gm;
/** The `; Line N` comment added for the vendored parser, as the parser returns it. */
const addedLineComment = /^\s*; Line \d+ <coglens>$/;
/**
 * The address and encoded bytes that `/FAcs` writes before an instruction, or the bytes alone on
 * the continuation of a long encoding. MSVC writes them in lowercase, and its directives, such
 * as `DD`, in uppercase.
 */
const msvcCodeColumns = /^\s*(?:[0-9a-f]{5,16}\s+)?(?:[0-9a-f]{2}\s+)+/;
const msvcProcedureEnd = /^\S.*?[ \t]+ENDP\b/;
const msvcLabelLine = /^(\S+):$/;
/** A jump or a call, its distance, and its target, which runs to the comment. */
const msvcBranch = /^(\s*(?:j[a-z]+|call)\s+(?:SHORT\s+|NEAR\s+)?)(\S.*?)\s*(?:;.*)?$/;

/**
 * Adds the label definitions and the jump and call targets, which the vendored parser leaves out.
 * Local labels such as `$LN4` repeat in each function, so a label in a function is keyed by both.
 * Columns count from 1, as in the vendored parser.
 */
function withMsvcLabels(parsed: ParsedAsmResult): ParsedAsmResult {
	const scoped = (procedure: string | undefined, label: string): string =>
		procedure === undefined ? label : `${procedure}\0${label}`;
	const labelDefinitions: Record<string, number> = {};
	let procedure: string | undefined;
	parsed.asm.forEach((line, index) => {
		const start = masmProcedureLine.exec(line.text)?.[1];
		const label = msvcLabelLine.exec(line.text)?.[1];
		if (start !== undefined) {
			procedure = start;
			labelDefinitions[start] = index + 1;
		} else if (msvcProcedureEnd.test(line.text)) {
			procedure = undefined;
		} else if (label !== undefined) {
			labelDefinitions[scoped(procedure, label)] = index + 1;
		}
	});

	procedure = undefined;
	const asm = parsed.asm.map((line) => {
		const start = masmProcedureLine.exec(line.text)?.[1];
		if (start !== undefined || msvcProcedureEnd.test(line.text)) {
			procedure = start;
			return line;
		}
		const instruction = line.text.replace(msvcCodeColumns, '');
		const branch = msvcBranch.exec(instruction);
		const name = branch?.[2];
		const target = name && [scoped(procedure, name), name].find((key) => Object.hasOwn(labelDefinitions, key));
		if (!branch || !name || !target) {
			return line;
		}
		const startCol = line.text.length - instruction.length + branch[1].length + 1;
		const range = { startCol, endCol: startCol + name.length };
		return { ...line, labels: [{ name, ...(target === name ? {} : { target }), range }] };
	});
	return { ...parsed, asm, labelDefinitions };
}

/**
 * Reads the source line of each instruction in a `/FAcs` listing. The vendored parser expects the
 * `/FA` form: a `; Line N` comment, and the instruction at the start of its line. `/FAcs` writes
 * the source text in place of that comment. It also writes the address and bytes before each
 * instruction. A `; Line N` comment goes before each source comment for the parser, and is removed
 * from what the parser returns. The opcode test skips the address and bytes. The parser also finds
 * no labels, so they are added after it.
 */
class MsvcListingParser extends VcAsmParser {
	override hasOpcode(line: string): boolean {
		return super.hasOpcode(line.replace(msvcCodeColumns, ''));
	}

	override processAsm(asm: string, filters: ParseFiltersAndOutputOptions): ParsedAsmResult {
		if (filters.binary || filters.binaryObject) {
			return super.processAsm(asm, filters);
		}
		const parsed = super.processAsm(asm.replace(msvcSourceComment, '; Line $1 <coglens>\n$&'), filters);
		return withMsvcLabels({ ...parsed, asm: parsed.asm.filter((line) => !addedLineComment.test(line.text)) });
	}
}

/** Creates the MSVC-specific parser used for textual assembly listings. */
export function createMsvcAsmParser(): VcAsmParser {
	return new MsvcListingParser(noopPropertyGetter);
}

/** Builds CL.exe arguments for line-mapped assembly or an object file. */
export function msvcOutputArguments(target: 'assembly' | 'object', outputFile: string): readonly string[] {
	return target === 'assembly'
		? ['/nologo', '/c', '/FAcs', `/Fa${outputFile}`, `/Fo${outputFile}.obj`, `/Fd${outputFile}.pdb`]
		: ['/nologo', '/c', '/Z7', `/Fo${outputFile}`];
}

/** Builds clang-cl output arguments while retaining debug information required for source mapping. */
export function clangClOutputArguments(target: 'assembly' | 'object', outputFile: string): readonly string[] {
	return target === 'assembly'
		? ['/Z7', ...msvcOutputArguments('assembly', outputFile)]
		: msvcOutputArguments('object', outputFile);
}

const environmentCache = new Map<string, Promise<NodeJS.ProcessEnv>>();

/** Loads and caches the Visual Studio build environment, then layers invocation overrides over it. */
export async function captureWindowsEnvironment(
	profile: ToolchainProfile,
	environment: NodeJS.ProcessEnv,
	cancellationToken: CancellationToken,
): Promise<NodeJS.ProcessEnv> {
	const architecture = vcvarsArchitecture(profile.executable);
	const cacheKey = `${localFileComparisonKey(profile.executable)}\0${architecture}`;
	let environmentPromise = environmentCache.get(cacheKey);
	if (!environmentPromise) {
		environmentPromise = captureVisualStudioEnvironment(
			{ ...process.env },
			profile.executable,
			architecture,
			cancellationToken,
		);
		environmentCache.set(cacheKey, environmentPromise);
		void environmentPromise.catch(() => {
			if (environmentCache.get(cacheKey) === environmentPromise) {
				environmentCache.delete(cacheKey);
			}
		});
	}
	const visualStudioEnvironment = { ...(await environmentPromise) };
	for (const [name, value] of Object.entries(environment)) {
		if (value !== process.env[name]) {
			visualStudioEnvironment[name] = value;
		}
	}
	return visualStudioEnvironment;
}

async function captureVisualStudioEnvironment(
	baseEnvironment: NodeJS.ProcessEnv,
	executable: string,
	vcvarsArchitectureValue: string,
	cancellationToken: CancellationToken,
): Promise<NodeJS.ProcessEnv> {
	const vcvarsScript = await findVisualStudioEnvironmentScript(executable, baseEnvironment, cancellationToken);

	const toolset = visualStudioToolsetArgument(executable);
	const captureCommand = `call "${vcvarsScript}" ${vcvarsArchitectureValue}${toolset ? ` ${toolset}` : ''} >nul && set`;
	const result = await exec.execute('cmd.exe', ['/d', '/s', '/c', captureCommand], {
		env: baseEnvironment,
		cancellationToken,
		windowsVerbatimArguments: true,
	});
	if (result.returnCode !== 0) {
		throw new Error(`Visual Studio environment setup failed with code ${result.returnCode}: ${result.stderr}`);
	}

	const captured: NodeJS.ProcessEnv = { ...baseEnvironment };
	for (const line of result.stdout.split(/\r?\n/)) {
		const separator = line.indexOf('=');
		if (separator > 0) {
			captured[line.slice(0, separator)] = line.slice(separator + 1);
		}
	}

	return captured;
}

/**
 * Finds vcvarsall.bat in the Visual Studio install that holds the compiler, or else in the latest
 * install. With two installs, the latest one gives the wrong headers to a compiler in the other.
 */
async function findVisualStudioEnvironmentScript(
	executable: string,
	baseEnvironment: NodeJS.ProcessEnv,
	cancellationToken: CancellationToken,
): Promise<string> {
	for (const candidate of visualStudioEnvironmentCandidates(executable)) {
		if (fs.existsSync(candidate)) {
			return candidate;
		}
	}

	const programFilesX86 = baseEnvironment['ProgramFiles(x86)'] ?? baseEnvironment.PROGRAMFILES_X86;
	if (programFilesX86) {
		const vswhere = path.join(programFilesX86, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
		if (fs.existsSync(vswhere)) {
			try {
				const result = await exec.execute(vswhere, visualStudioDiscoveryArguments, {
					env: baseEnvironment,
					cancellationToken,
				});
				if (result.returnCode === 0) {
					const installationPath = result.stdout
						.split(/\r?\n/)
						.find((line) => line.trim())
						?.trim();
					if (installationPath) {
						const discovered = path.join(installationPath, 'VC', 'Auxiliary', 'Build', 'vcvarsall.bat');
						if (fs.existsSync(discovered)) {
							return discovered;
						}
					}
				}
			} catch (error) {
				if (error instanceof ExecError && error.kind === 'cancelled') {
					throw error;
				}
			}
		}
	}
	throw new Error(`Visual Studio environment script was not found relative to ${executable} or through vswhere`);
}

function vcvarsArchitecture(executable: string): string {
	const compilerDirectory = path.dirname(executable);
	const target = normalizeArchitecture(path.basename(compilerDirectory));
	const hostMatch = /^Host(.+)$/i.exec(path.basename(path.dirname(compilerDirectory)));
	if (target && hostMatch) {
		const host = normalizeArchitecture(hostMatch[1]);
		if (host) {
			return host === target ? target : `${host}_${target}`;
		}
	}

	const host = normalizeArchitecture(process.arch);
	if (!host) {
		throw new Error(`Unsupported host architecture: ${process.arch}`);
	}
	return host;
}

function normalizeArchitecture(value: string): string | undefined {
	switch (value.toLowerCase()) {
		case 'x64':
		case 'amd64':
			return 'amd64';
		case 'x86':
		case 'ia32':
			return 'x86';
		case 'arm':
			return 'arm';
		case 'arm64':
			return 'arm64';
		default:
			return undefined;
	}
}

/**
 * dumpbin prints no line numbers for an object or an image, so the lines come from the CodeView
 * line table of the object.
 */
export const dumpbin: BinaryDisassembler = Object.freeze({
	tool: 'disassembler',
	arguments: (objectFile: string) => ['/nologo', '/disasm:bytes', objectFile],
	normalizeOutput: async (output: string, objectFile: string) =>
		withCodeViewSourceLines(normalizeDumpbinOutput(output), await objectCodeViewLines(objectFile)),
});

/** Reads the line table of an object file. Without one, the listing has no line information. */
export async function objectCodeViewLines(objectFile: string): Promise<CodeViewLineTable> {
	try {
		return readCodeViewLines(await readBoundedArtifactBuffer(objectFile));
	} catch {
		return new Map();
	}
}

/** Converts dumpbin's COFF listing into the GNU/LLVM objdump shape used by the shared parser. */
export function normalizeDumpbinOutput(output: string): string {
	const normalized: string[] = [];
	let pendingSymbol: string | undefined;
	for (const originalLine of output.split(/\r?\n/)) {
		const line = originalLine.trimEnd();
		const instruction = /^\s*([0-9a-f]+):\s*((?:[0-9a-f]{2}\s+)+)(.*)$/i.exec(line);
		if (instruction) {
			const address = instruction[1].toLowerCase();
			if (pendingSymbol) {
				normalized.push(`${address} <${pendingSymbol}>:`);
				pendingSymbol = undefined;
			}
			normalized.push(`${address}: ${instruction[2].toLowerCase()}${instruction[3]}`);
			continue;
		}
		const addressAndSymbol = /^\s*([0-9a-f]+)\s+<?([^<>:]+)>?:\s*$/i.exec(line);
		if (addressAndSymbol) {
			normalized.push(`${addressAndSymbol[1].toLowerCase()} <${addressAndSymbol[2].trim()}>:`);
			pendingSymbol = undefined;
			continue;
		}
		// A heading names the symbol, then the demangled name in parentheses, which can hold colons.
		const symbol = /^\s*([?$@A-Z_a-z][^\s(]*)(?:\s+\(.*\))?:$/.exec(line);
		if (symbol) {
			pendingSymbol = symbol[1];
		}
	}
	// dumpbin names the target of a call or jump to another function. An address alone is a branch
	// in the same section. Each COMDAT function starts at 0, so the address does not name a function.
	// dumpbin writes the address in uppercase, and the addresses of the instructions are lowercase.
	const addressBySymbol = new Map<string, string>();
	for (const line of normalized) {
		const label = /^([0-9a-f]+) <(.+)>:$/.exec(line);
		if (label) {
			addressBySymbol.set(label[2], label[1]);
		}
	}
	return normalized
		.map((line) => {
			const numericBranch = /(\b(?:call|j[a-z]+)\s+)([0-9A-F]{8}|[0-9A-F]{16})$/.exec(line);
			if (numericBranch) {
				return `${line.slice(0, numericBranch.index)}${numericBranch[1]}${numericBranch[2].toLowerCase()}`;
			}
			const symbolicBranch = /\b(?:call|j[a-z]+)\s+(\S+)$/i.exec(line);
			const address = symbolicBranch ? addressBySymbol.get(symbolicBranch[1]) : undefined;
			return symbolicBranch && address
				? line.replace(symbolicBranch[1], `${address} <${symbolicBranch[1]}>`)
				: line;
		})
		.join('\n');
}

/**
 * Compiles once more to list the inputs. The object and the program database go to the temporary
 * directory. Without `/Fd`, `/Zi` in the provider arguments writes `vc140.pdb` into the working
 * directory.
 */
export const msvcDependencyCollection: DependencyCollectionSpec = Object.freeze({
	outputFilename: 'dependencies.json',
	arguments: (outputFile: string, temporaryDirectory: string) => [
		'/c',
		'/sourceDependencies',
		outputFile,
		`/Fo${path.join(temporaryDirectory, 'dependencies.obj')}`,
		`/Fd${path.join(temporaryDirectory, 'dependencies.pdb')}`,
	],
	parse: parseMsvcSourceDependencies,
});
// cl.exe accepts either option prefix, and its option names are case-sensitive: /Fi names the
// preprocessed output, while /FI force-includes a header and stays with the provider.
const msvcOutputFlags = /^[-/](?:Fo|Fa|Fd|Fi|Fe)$/;
const msvcOutputAssignments = /^[-/](?:Fo|Fa|Fd|Fi|Fe).+/;
const msvcDependencyFlags = /^[-/]sourceDependencies(?::directives)?$/;
const msvcModeFlags = /^[-/](?:c|E|EP|P|Zs|FA[csu]*)$/;

/**
 * Output, dependency, and mode switches that cl.exe owns. Runtime library switches such as
 * -MD and -MTd, which share their spelling with GCC dependency flags, stay with the provider.
 */
export const msvcOwnedArguments = {
	withValue: [msvcOutputFlags, msvcDependencyFlags],
	standalone: [msvcModeFlags, msvcOutputAssignments],
} as const satisfies OwnedArguments;

export function stripMsvcManagedArguments(
	args: readonly string[],
	sourceFile: string,
	workingDirectory?: string,
): string[] {
	return withoutOwnedArguments(args, sourceFile, workingDirectory, msvcOwnedArguments);
}

export const msvcPreprocessedSourceProducer = outputProducer({
	output: 'stdout',
	arguments: () => ['/E'],
});

export const msvc: ToolchainDefinition = {
	executablePattern: /^cl\.exe$/i,
	parseDiagnostics: parseParenthesizedDiagnostics,
	languageIdentifiers: cFamilyLanguageIdentifiers,
	intelSyntax: 'inherent',
	includeFlag: '/I',
	defineFlag: '/D',
	objectFilename: 'output.obj',
	outputArguments: msvcOutputArguments,
	stripOwnedArguments: stripMsvcManagedArguments,
	dependencyCollection: msvcDependencyCollection,
	createParser: createMsvcAsmParser,
	createCfgParser: () => new MsvcAssemblyCfgParser(),
	prepareEnvironment: captureWindowsEnvironment,
	discoverTools: (executable) => {
		const tools = toolDiscoverer({ demangler: 'undname', disassembler: 'dumpbin' })(executable);
		return Object.freeze({
			...tools,
			...(tools.demangler
				? { demangler: Object.freeze({ ...tools.demangler, inputMode: 'file-argument' as const }) }
				: {}),
		});
	},
	artifacts: {
		assembly: compilerAssembly,
		'binary-disassembly': binaryDisassembly('dumpbin', dumpbin),
		'preprocessed-source': { producer: msvcPreprocessedSourceProducer },
		'control-flow-graph': { outputs: [assemblyControlFlowGraphOutput] },
	},
};
