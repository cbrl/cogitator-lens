import path from 'node:path';
import type { ArtifactOutputSpec } from '../../toolchains/toolchain-backend.js';
import type { OptimizationRemarkCategory } from '../../types/index.js';
import { resolveCompilerPath } from '../../file-identity.js';
import { optimizationRemarksRenderer, type OptimizationRemark } from './optimization-remarks-renderer.js';

/**
 * cl.exe 19.52 prints one line on standard output for each loop that it optimizes:
 * `FILE(LINE) : info C5001: loop vectorized`. C5002 gives a reason code when the loop is not
 * vectorized. C5011 and C5012 give the same for the parallelizer, which needs `/Qpar`.
 */
const msvcRemark = /^(.*?)\((\d+)\)\s*:\s*info C(50\d\d)\s*:\s*(.*)$/u;

/**
 * cl.exe also writes its diagnostics to standard output, so the diagnostic parser reads the other
 * lines. It would show each remark as information.
 */
function withoutMsvcRemarks(text: string): string {
	return text
		.split(/\r?\n/u)
		.filter((line) => !msvcRemark.test(line))
		.join('\n');
}

/** `/Qpar-report:2` adds nothing without `/Qpar`. */
export const msvcOptimizationRemarksOutput: ArtifactOutputSpec = Object.freeze({
	output: 'stdout',
	arguments: (_outputFile: string, temporaryDirectory: string) => [
		'/c',
		'/Qvec-report:2',
		'/Qpar-report:2',
		`/Fo${path.join(temporaryDirectory, 'output.obj')}`,
	],
	outputDiagnostics: withoutMsvcRemarks,
});

const msvcRemarkKinds: Readonly<Record<string, readonly [string, OptimizationRemarkCategory]>> = {
	'5001': ['vectorizer', 'passed'],
	'5002': ['vectorizer', 'missed'],
	'5011': ['parallelizer', 'passed'],
	'5012': ['parallelizer', 'missed'],
};

/**
 * The reason codes of the vectorizer and the parallelizer, from "Vectorizer and parallelizer
 * messages" in the Microsoft C++ documentation. A long description has its first sentence only.
 */
const msvcLoopReasons: Readonly<Record<string, string>> = {
	'500': 'Induction variable discovery or recurrence failure.',
	'501': "Induction variable isn't local; or upper bound isn't loop-invariant.",
	'502': 'Induction variable is stepped in some manner other than a simple +1.',
	'503': 'Loop includes exception-handling or switch statements.',
	'504': 'Loop body may throw an exception that requires destruction of a C++ object.',
	'505': 'Outer loop has a pre-incremented induction variable.',
	'506': 'Loop structural or canonical form failure.',
	'507': 'Bounds, initialization, termination, or compare consistency failure.',
	'508': 'Stride derivation or usage failure.',
	'509': 'Loop direction acceptability failure.',
	'1000': 'The compiler detected a data dependency in the loop body.',
	'1001': 'The compiler detected a store to a scalar variable in the loop body, and that scalar has a use beyond the loop.',
	'1002': 'The compiler tried to parallelize a loop that has an inner loop that was already parallelized.',
	'1003': 'The loop body contains an intrinsic call that may read or write to memory.',
	'1004': "There's a scalar reduction in the loop body.",
	'1005': 'The no_parallel pragma was specified.',
	'1006': 'This function contains OpenMP.',
	'1007': "The loop induction variable or the loop bounds aren't signed 32-bit numbers (int or long).",
	'1008': "The compiler detected that this loop doesn't do enough work to justify auto-parallelization.",
	'1009': 'The compiler detected an attempt to parallelize a do-while loop.',
	'1010': 'The compiler detected that the loop is using not-equals (!=) for its condition.',
	'1100': 'Loop contains control flow, for example, if or ?:.',
	'1101': "Loop contains a (possibly implicit) datatype conversion that can't be vectorized.",
	'1102': 'Loop contains non-arithmetic or other non-vectorizable operations.',
	'1103': 'Loop body includes shift operations whose size might vary within the loop.',
	'1104': 'Loop body includes scalar variables.',
	'1105': 'Loop includes an unrecognized reduction operation.',
	'1106': 'Outer loop not vectorized.',
	'1200': 'Loop contains loop-carried data dependencies that prevent vectorization.',
	'1201': 'Array base changes during the loop.',
	'1202': "Field in a struct isn't 32 or 64 bits wide.",
	'1203': 'Loop body includes non-contiguous accesses into an array.',
	'1204': 'Compiler internal data structure limit hit: too many data dependence edges.',
	'1300': 'Loop body contains little or no computation.',
	'1301': "Loop stride isn't +1.",
	'1302': 'Loop is a do-while.',
	'1303': 'Too few loop iterations for vectorization to provide value.',
	'1304': 'Loop includes assignments that are of different sizes.',
	'1305': 'Not enough type information.',
	'1400': '#pragma loop(no_vector) is specified.',
	'1401': '/kernel switch is specified when targeting x86 or ARM.',
	'1402': "/arch:SSE2 or higher switch isn't specified when targeting x86.",
	'1403': '/arch:ATOM switch is specified and the loop includes operations on doubles.',
	'1404': '/O1 or /Os switch is specified.',
	'1405': 'Vectorization is disabled to aid in dynamic-initializer-to-static-initializer optimization.',
	'1500': 'Possible aliasing on multi-dimensional arrays.',
	'1501': 'Possible aliasing on arrays-of-structs.',
	'1502': 'Possible aliasing and array index is other than n + K.',
	'1503': 'Possible aliasing and array index has multiple offsets.',
	'1504': 'Possible aliasing; would require too many runtime checks.',
	'1505': 'Possible aliasing, but runtime checks are too complex.',
};

export function parseMsvcOptimizationRemarks(text: string, workingDirectory: string): OptimizationRemark[] {
	const remarks: OptimizationRemark[] = [];
	for (const line of text.split(/\r?\n/u)) {
		const match = msvcRemark.exec(line);
		if (!match) {
			continue;
		}
		const [pass, category] = msvcRemarkKinds[match[3]] ?? ['loop', 'analysis'];
		const reason = /\breason '(\d+)'/u.exec(match[4])?.[1];
		const description = reason ? msvcLoopReasons[reason] : undefined;
		remarks.push({
			file: resolveCompilerPath(match[1].trim(), workingDirectory),
			line: Number(match[2]),
			pass,
			category,
			message: description ? `${match[4]}: ${description}` : match[4],
		});
	}
	return remarks;
}

export const renderMsvcOptimizationRemarks = optimizationRemarksRenderer(parseMsvcOptimizationRemarks);
