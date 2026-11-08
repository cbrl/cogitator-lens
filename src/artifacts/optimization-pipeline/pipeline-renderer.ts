import type { DisplayOptions, PipelinePass, RawArtifact, RenderedTextArtifact } from '../../types/index.js';
import type { ArtifactRenderContext } from '../core/artifact-contracts.js';
import { renderedArtifact } from '../core/rendered-artifact.js';
import { LlvmPassDumpParser } from '../../vendor/lib/parsers/llvm-pass-dump-parser.js';
import type { Pass } from '../../vendor/types/compilation/opt-pipeline-output.interfaces.js';

// The parser keeps no state between calls, so one parser serves each listing.
const parser = new LlvmPassDumpParser();

/** The key of the parser result in its full-module mode. */
const fullModuleKey = '<Full Module>';

/** The function filter of a compile, from the LLVM option in its arguments. */
const functionFilterArgument = /-filter-print-funcs=(\S+)/u;

/**
 * Reads the passes of an optimization pipeline from LLVM `-print-before-all` and
 * `-print-after-all` output. The compile prints one function only, so the full-module mode keeps
 * each pass. The mode that splits the dumps by function drops the machine passes of a function
 * whose name has a character such as `?` or `@`, such as each MSVC name.
 */
export function parsePipelinePasses(text: string): readonly Pass[] {
	const lines = text.split(/\r?\n/u).map((line) => ({ text: line }));
	// Without a dump header, the parser starts at the last line, and then it fails.
	const hasDump = lines.some(
		(line) =>
			parser.irDumpHeader.test(line.text) ||
			parser.machineCodeDumpHeader.test(line.text) ||
			parser.cirDumpHeader.test(line.text),
	);
	if (!hasDump) {
		return [];
	}
	try {
		const results = parser.process(lines, {}, { filterDebugInfo: true, filterIRMetadata: false, fullModule: true });
		return results[fullModuleKey] ?? [];
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`The pass output of the compiler has a form that Cogitator Lens cannot read: ${message}`);
	}
}

/**
 * Lists the passes of the pipeline, one pass on each line. By default, the list shows only the
 * passes that changed the function. Each listed pass keeps the text of the function before and
 * after it, for the comparison.
 */
export function renderOptimizationPipeline(
	raw: RawArtifact,
	options: DisplayOptions,
	_context: ArtifactRenderContext,
): RenderedTextArtifact {
	// A dump can end with a blank line, such as the last dump of the output. The comparison ignores
	// blank lines at the end, so the last pass does not seem to change the function.
	const parsed = parsePipelinePasses(raw.text).map((pass) => {
		const before = dumpText(pass.before);
		const after = dumpText(pass.after);
		return { name: pass.name, machine: pass.machine, before, after, changed: before !== after };
	});
	const functionName = functionFilterArgument.exec(raw.command.args.join(' '))?.[1] ?? 'the function';
	const changedCount = parsed.filter((pass) => pass.changed).length;
	const machineCount = parsed.filter((pass) => pass.machine).length;
	const header = pipelineHeader(functionName, parsed.length, changedCount, options.showUnchangedPasses);
	const numberWidth = String(parsed.length).length;
	const passes: PipelinePass[] = [];
	const lines = header.map((text) => ({ text }));
	parsed.forEach((pass, index) => {
		if (!pass.changed && !options.showUnchangedPasses) {
			return;
		}
		const number = index + 1;
		passes.push({ ...pass, line: lines.length, number });
		const marker = pass.changed ? '*' : ' ';
		const machine = pass.machine ? ' (machine code)' : '';
		lines.push({ text: `${String(number).padStart(numberWidth)} ${marker} ${pass.name}${machine}` });
	});
	return {
		...renderedArtifact(raw, lines, {
			passCount: parsed.length,
			changedPassCount: changedCount,
			machinePassCount: machineCount,
		}),
		passes,
	};
}

/** The text of one dump, without blank lines at its end. */
function dumpText(lines: readonly { readonly text: string }[]): string {
	return lines
		.map((line) => line.text)
		.join('\n')
		.trimEnd();
}

function pipelineHeader(
	functionName: string,
	passCount: number,
	changedCount: number,
	showUnchangedPasses: boolean,
): string[] {
	if (passCount === 0) {
		return [
			`; The compiler printed no passes for ${functionName}.`,
			'; The function can be missing from the compiled code, for example after a rename.',
			'; Run "Open Artifact" again to select a function.',
		];
	}
	const ran = `${passCount} ${passCount === 1 ? 'pass' : 'passes'} ran.`;
	const changed = `${changedCount} ${changedCount === 1 ? 'pass' : 'passes'} changed the function`;
	return [
		`; Optimization pipeline of ${functionName}`,
		showUnchangedPasses
			? `; ${ran} ${changed}, and a * marks each of them.`
			: `; ${ran} ${changed}, and the list shows only them.`,
		'; Ctrl+Click a pass, or run "Show Pass Change" on its line, to compare the function before and after it.',
		'',
	];
}
