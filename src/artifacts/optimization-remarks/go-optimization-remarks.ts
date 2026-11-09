import type { OptimizationRemarkCategory } from '../../types/index.js';
import { resolveCompilerPath } from '../../file-identity.js';
import { optimizationRemarksRenderer, type OptimizationRemark } from './optimization-remarks-renderer.js';

/**
 * `go build -gcflags=-m=2` prints one remark on each line: `FILE:LINE:COLUMN: MESSAGE`. Go 1.24 and
 * 1.26 also explain each escape on more lines with the same location. The first line ends with a
 * colon, and the message of each next line starts with spaces. A later line gives the remark itself,
 * so the explanations are left out.
 */
const goRemark = /^(.+?\.go):(\d+):(\d+): (.*)$/u;

/** The pass and the category of each kind of message. Other messages are analysis. */
const goRemarkKinds: readonly (readonly [RegExp, string, OptimizationRemarkCategory])[] = [
	[/^inlining call to /u, 'inline', 'passed'],
	[/^cannot inline /u, 'inline', 'missed'],
	[/^can inline /u, 'inline', 'analysis'],
	[/^devirtualizing /u, 'devirtualize', 'passed'],
	[/ does not escape$/u, 'escape', 'passed'],
	[/ escapes to heap$|^moved to heap: /u, 'escape', 'missed'],
	[/^leaking param/u, 'escape', 'analysis'],
];

export function parseGoOptimizationRemarks(text: string, workingDirectory: string): OptimizationRemark[] {
	const remarks: OptimizationRemark[] = [];
	for (const line of text.split(/\r?\n/u)) {
		const match = goRemark.exec(line);
		if (!match || /^\s|:$/u.test(match[4])) {
			continue;
		}
		// "can inline add with cost 4 as: func(int, int) int { return a + b }" also prints the body.
		const message = match[4].replace(/^(can inline .+? with cost \d+) as: .*$/u, '$1');
		const [, pass, category] = goRemarkKinds.find(([pattern]) => pattern.test(message)) ?? [
			undefined,
			'go',
			'analysis',
		];
		remarks.push({
			file: resolveCompilerPath(match[1], workingDirectory),
			line: Number(match[2]),
			column: Number(match[3]),
			pass,
			category,
			message,
		});
	}
	return remarks;
}

export const renderGoOptimizationRemarks = optimizationRemarksRenderer(parseGoOptimizationRemarks);
