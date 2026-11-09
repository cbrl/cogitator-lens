import type { OptimizationRemarkCategory } from '../../types/index.js';
import { resolveCompilerPath } from '../../file-identity.js';
import { optimizationRemarksRenderer, type OptimizationRemark } from './optimization-remarks-renderer.js';

/**
 * With `-C remark=all`, rustc 1.93 and 1.97 print each LLVM remark as a note on standard error:
 * `note: FILE:LINE:COLUMN PASS (KIND): MESSAGE`. The next lines of a long message have an indent. A
 * file of `<unknown file>` or a line of 0 means that the remark has no location. On Windows, the
 * column is always 0.
 */
const rustRemark = /^note: (.+?):(\d+):(\d+) (\S+) \((\w+)\): ?(.*)$/u;

/** rustc names the kinds `success`, `missed`, and `analysis`. */
const rustRemarkCategories: Readonly<Record<string, OptimizationRemarkCategory>> = {
	success: 'passed',
	missed: 'missed',
};

/**
 * `-C remark=all` also turns on the size-info remarks, which give the instruction count after each
 * pass. The optimization record of Clang does not have them, so they are left out.
 */
const excludedPasses: ReadonlySet<string> = new Set(['size-info']);

export function parseRustOptimizationRemarks(text: string, workingDirectory: string): OptimizationRemark[] {
	const notes: { readonly match: RegExpExecArray; readonly message: string[] }[] = [];
	let current: (typeof notes)[number] | undefined;
	for (const line of text.split(/\r?\n/u)) {
		const match = rustRemark.exec(line);
		if (match) {
			current = { match, message: [match[6].trim()] };
			notes.push(current);
		} else if (current && /^\s/u.test(line)) {
			current.message.push(line.trim());
		} else {
			current = undefined;
		}
	}
	return notes
		.filter(({ match }) => !excludedPasses.has(match[4]))
		.map(({ match, message }) => {
			const [, file, line, column, pass, kind] = match;
			const location =
				Number(line) > 0 && !file.startsWith('<')
					? {
							file: resolveCompilerPath(file, workingDirectory),
							line: Number(line),
							...(Number(column) > 0 ? { column: Number(column) } : {}),
						}
					: {};
			return {
				...location,
				pass,
				category: rustRemarkCategories[kind] ?? 'analysis',
				message: message.filter(Boolean).join(' '),
			};
		});
}

export const renderRustOptimizationRemarks = optimizationRemarksRenderer(parseRustOptimizationRemarks);
